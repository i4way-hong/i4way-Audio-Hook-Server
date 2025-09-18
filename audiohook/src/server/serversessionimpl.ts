import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import {
    ClientMessage,
    CloseMessage,
    CloseParameters,
    DiscardedMessage,
    DisconnectReason,
    ErrorMessage,
    EventEntities,
    LanguageCode,
    MediaParameter,
    MessageDispatcher,
    OpenedParameters,
    OpenMessage,
    PausedMessage,
    PingMessage,
    ResumedMessage,
    SelectParametersForType,
    ServerMessage,
    ServerMessageBase,
    ServerMessageType,
    SupportedLanguages,
    UpdateMessage,
    UpdateParameters,
    Uuid,
} from '../protocol/message';
import {
    isClientMessageBase,
    isClientMessage,
    isClientMessageType,
    isNullUuid
} from '../protocol/validators';
import {
    StreamDuration,
    isPromise,
    normalizeError,
    Logger,
} from '../utils';
import {
    TimeProvider,
    defaultTimeProvider,
} from '../utils/timeprovider';
import {
    MediaDataFrame,
    mediaDataFrameFromMessage
} from './mediadata';
import {
    Authenticator,
    CloseHandler,
    FiniHandler,
    MediaSelector,
    OnAudioHandler,
    OnClientMessageHandler,
    OnDiscardedHandler,
    OnErrorHandler,
    OnPausedHandler,
    OnResumedHandler,
    OnServerMessageHandler,
    OnStatisticsHandler,
    OnUpdateHandler,
    OpenHandler,
    OpenTransactionContext,
    ServerSession,
    ServerSessionState,
    StatisticsInfo,
    UpdateHandler,
} from './serversession';
import { WavFileWriter } from '../audio/wav';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import recordingConfig from '../utils/config';
import sttConfig from '../utils/stt-config';
import { createSttForwarder, SttForwarder } from './stt-forwarder';

type StateToBooleanMap = {
    readonly [state in ServerSessionState]: boolean
};

// Map that indicates whether errors are signaled to client in a state.
const suppressErrorSignalStateMap: StateToBooleanMap = {
    'PREPARING': false,
    'OPENING': false,
    'ACTIVE': false,
    'PAUSED': false,
    'CLOSING': false,
    'CLOSED': true,
    'SIGNALED-ERROR': true,
    'UNAUTHORIZED': true,
    'FINALIZING': true,
    'DISCONNECTED': true,
};

// Map that indicates whether we can send disconnect in a state.
const sendDisconnectInState: StateToBooleanMap = {
    'PREPARING': true,
    'OPENING': true,
    'ACTIVE': true,
    'PAUSED': true,
    'CLOSING': false,
    'CLOSED': false,
    'SIGNALED-ERROR': false,
    'UNAUTHORIZED': false,
    'FINALIZING': false,
    'DISCONNECTED': false,
};


/**
 * Interface of methods the AudioHook ServerSession implementation requires from the WebSocket connection
 *
 * @see createServerSession
 */
export interface ServerWebSocket {
    close(): void;
    send(data: string | Uint8Array): void;
    on(event: 'close', listener: (this: ServerWebSocket, code: number) => void): this;
    on(event: 'error', listener: (this: ServerWebSocket, err: Error) => void): this;
    on(event: 'message', listener: (this: ServerWebSocket, data: Uint8Array, isBinary: boolean) => void): this;
}

export type ServerSessionOptions = {
    ws: ServerWebSocket;
    id: Uuid;
    logger: Logger;
    timeProvider?: TimeProvider;
    supportedLanguages?: SupportedLanguages;
};


export const createServerSession = (options: ServerSessionOptions): ServerSession => {
    return ServerSessionImpl.create(options);
};


class ServerSessionImpl extends EventEmitter implements ServerSession {
    readonly ws: ServerWebSocket;
    readonly logger: Logger;
    readonly messageDispatch: MessageDispatcher<ClientMessage>;

    id: Uuid;
    seq = 0;
    clientseq = 0;
    selectedMedia: Readonly<MediaParameter> | null = null;
    language: LanguageCode | null = null;
    sendSupportedLanguages = false;
    supportedLanguages: SupportedLanguages | null = null;
    position: StreamDuration = StreamDuration.zero;
    startPaused = false;
    openTransactionPromise: Promise<void> | null = null;
    state: ServerSessionState = 'PREPARING';
    timeProvider: TimeProvider;
    lastPingTimestamp: bigint;

    authenticators: Authenticator[] = [];
    mediaSelectors: MediaSelector[] = [];
    openHandlers: OpenHandler[] = [];
    updateHandlers: UpdateHandler[] = [];
    closeHandlers: CloseHandler[] = [];
    finiHandlers: FiniHandler[] = [];

    // WAV 기록 관련 상태
    private audioWriter: WavFileWriter | null = null;
    private audioWriterPromise: Promise<WavFileWriter | null> | null = null;
    private pendingAudioFrames: MediaDataFrame[] = [];
    private recordingFilePath: string | null = null;
    // 파일 저장 기능 설정
    private fileRecordingEnabled = true;
    private fileRecordingRoot: string = join(process.cwd(), 'recordings');
    private unsubscribeConfig?: () => void;
    private recordingWatchTimer: NodeJS.Timeout | null = null;
    private isRotating = false;
    private sttForwarder: SttForwarder | null = null;
    private sttForwarderPromise: Promise<SttForwarder | null> | null = null;

    private constructor({ ws, id, logger, timeProvider, supportedLanguages }: ServerSessionOptions) {
        super();
        this.ws = ws;
        this.id = id;
        this.logger = logger;
        this.timeProvider = timeProvider ?? defaultTimeProvider;
        this.supportedLanguages = supportedLanguages ?? null;
        this.lastPingTimestamp = this.timeProvider.getHighresTimestamp();
        // 글로벌 설정에서 초기값 반영 및 업데이트 구독
        this.fileRecordingEnabled = recordingConfig.recordingEnabled;
        this.fileRecordingRoot = recordingConfig.logRootDir ?? this.fileRecordingRoot;
        this.unsubscribeConfig = recordingConfig.onUpdate((next) => {
            const wasEnabled = this.fileRecordingEnabled;
            const prevRoot = this.fileRecordingRoot;
            this.fileRecordingEnabled = next.recordingEnabled;
            this.fileRecordingRoot = next.logRootDir ?? this.fileRecordingRoot;
            if (wasEnabled && !this.fileRecordingEnabled) {
                // 비활성화됨: 현재 파일 닫고 큐 제거
                (async () => {
                    try {
                        if (this.audioWriter) {
                            const samples = await this.audioWriter.close();
                            this.logger.info(`Recording disabled, file closed (${samples} samples)`);
                        } else if (this.audioWriterPromise) {
                            const w = await this.audioWriterPromise;
                            if (w) {
                                const samples = await w.close();
                                this.logger.info(`Recording disabled, file closed (${samples} samples)`);
                            }
                        }
                    } catch (e) {
                        this.logger.warn(`Error closing on disable: ${normalizeError(e).message}`);
                    } finally {
                        this.audioWriter = null;
                        this.audioWriterPromise = null;
                        this.pendingAudioFrames = [];
                        this.recordingFilePath = null;
                    }
                })().catch(() => void 0);
            } else if (this.fileRecordingEnabled && prevRoot !== this.fileRecordingRoot) {
                if (recordingConfig.immediateRotate) {
                    try {
                        void this.rotateRecordingFile();
                    } catch (e) {
                        this.logger.warn(`rotateRecordingFile failed: ${normalizeError(e).message}`);
                    }
                } else {
                    this.logger.info(`Recording directory changed: ${prevRoot} -> ${this.fileRecordingRoot} (applies to next file)`);
                }
            }
        });

        // STT 설정 구독: 주요 변경 시 재연결
        sttConfig.onUpdate(async () => {
            try {
                await this.restartSttForwarderIfNeeded(true);
            } catch (e) {
                this.logger.warn(`restartSttForwarderIfNeeded failed: ${normalizeError(e).message}`);
            }
        });
        this.registerHandlers();
        this.messageDispatch = {
            open: msg => this.onOpenMessage(msg),
            close: msg => this.onCloseMessage(msg),
            discarded: msg => this.onDiscardedMessage(msg),
            error: msg => this.onErrorMessage(msg),
            ping: msg => this.onPingMessage(msg),
            update: msg => this.onUpdateMessage(msg),
            paused: msg => this.onPausedMessage(msg),
            resumed: msg => this.onResumedMessage(msg),
        } as const;
    }

    static create(options: ServerSessionOptions): ServerSession {
        return new ServerSessionImpl(options);
    }

    setState(state: ServerSessionState): void {
        this.state = state;
    }

    addAuthenticator(handler: Authenticator): this {
        if (this.state === 'PREPARING') {
            this.authenticators.push(handler);
        } else {
            throw new Error(`Cannot add authenticator in state ${this.state}`);
        }
        return this;
    }

    addMediaSelector(handler: MediaSelector): this {
        if (this.state === 'PREPARING') {
            this.mediaSelectors.push(handler);
        } else {
            throw new Error(`Cannot add media selector in state ${this.state}`);
        }
        return this;
    }

    addOpenHandler(handler: OpenHandler): this {
        if ((this.state === 'PREPARING') || (this.state === 'OPENING')) {
            this.openHandlers.push(handler);
        } else {
            throw new Error(`Cannot add open handler in state ${this.state}`);
        }
        return this;
    }

    addUpdateHandler(handler: UpdateHandler): this {
        if ((this.state !== 'FINALIZING') && (this.state !== 'DISCONNECTED')) {
            this.updateHandlers.push(handler);
        } else {
            throw new Error(`Cannot add update handler in state ${this.state}`);
        }
        return this;
    }

    addCloseHandler(handler: CloseHandler): this {
        if ((this.state !== 'FINALIZING') && (this.state !== 'DISCONNECTED')) {
            this.closeHandlers.push(handler);
        } else {
            throw new Error(`Cannot add close handler in state ${this.state}`);
        }
        return this;
    }

    addFiniHandler(handler: FiniHandler): this {
        if (this.state !== 'DISCONNECTED') {
            this.finiHandlers.push(handler);
        } else {
            throw new Error(`Cannot add fini handler in state ${this.state}`);
        }
        return this;
    }

    pause(): void {
        if ((this.state === 'OPENING') || (this.state === 'PREPARING')) {
            this.startPaused = true;
        } else if ((this.state === 'ACTIVE') || (this.state === 'PAUSED')) {
            // Note: We allow sending pause even if it's already paused (message is idempotent/interrogating)
            this.buildAndSendMessage('pause', {});
        }
    }

    resume(): void {
        if ((this.state === 'OPENING') || (this.state === 'PREPARING')) {
            this.startPaused = false;
        } else if ((this.state === 'ACTIVE') || (this.state === 'PAUSED')) {
            // Note: We allow sending resume even if it's already active (message is idempotent/interrogating)
            this.buildAndSendMessage('resume', {});
        }
    }

    disconnect(reason: DisconnectReason | Error, info?: string): void {
        if (sendDisconnectInState[this.state]) {
            if (reason instanceof Error) {
                this.signalError(reason);
            } else if (reason === 'error') {
                this.signalClientError(info ?? '');
            } else {
                if (reason === 'unauthorized') {
                    this.setState('UNAUTHORIZED');
                }
                this.buildAndSendMessage('disconnect', { reason, info });
            }
        }
    }

    sendEvent(entities: EventEntities): boolean {
        if ((this.state === 'ACTIVE') || (this.state === 'PAUSED') || (this.state === 'CLOSING')) {
            this.buildAndSendMessage('event', { entities });
            return true;
        } else {
            return false;
        }
    }

    registerHandlers(): void {
        this.ws.on('close', (code: number) => {
            try {
                this.onWsClose(code);
            } catch (err) {
                this.logger.error(`Error in WS close handler: ${normalizeError(err).stack}`);
            }
        });
        this.ws.on('message', (data, isBinary): void => {
            try {
                if (isBinary) {
                    this.onBinaryMessage(data);
                } else {
                    this.onTextMessage(Buffer.from(data).toString('utf8'));
                }
            } catch (err) {
                this.logger.error(`Error processing message: ${normalizeError(err).stack}`);
                if (err instanceof Error) {
                    this.signalError(err.message ?? 'Internal server error');
                } else {
                    this.signalError('Undefined internal server error');
                }
            }
        });
        this.ws.on('error', (error: Error) => {
            this.logger.error(`Websocket error, forcing close (SessionState: ${this.state}): ${error.stack}`);
            this.ws.close();
        });
    }

    onWsClose(code: number): void {
        if (this.state !== 'CLOSED') {
            this.logger.warn(`onWsClose - Websocket closed in state ${this.state}! Code: ${code}"`);
        } else {
            this.logger.info(`onWsClose - Websocket closed. Code: ${code}`);
        }
        this.setState('FINALIZING');
        // 설정 구독 해제
        try {
            this.unsubscribeConfig?.();
        } catch {
            /* ignore */
        }
        this.stopRecordingWatch();
        // STT 포워더 종료
        const fwd = this.sttForwarder;
        this.sttForwarder = null;
        if (fwd) {
            void fwd.stop();
        }

        // Run close handlers in case we didn't get a close or if there are any stragglers. After that run all fini handlers.
        (this.openTransactionPromise ?? Promise.resolve())
            .finally(() => {
                return this.runCloseHandlers(null);
            })
            .finally(() => {
                return this.runFiniHandlers();
            })
            .finally(() => {
                this.setState('DISCONNECTED');
                this.logger.info('onWsClose - All fini handlers completed, changed state to DISCONNECTED');
            });
    }

    buildAndSendMessage<Type extends ServerMessageType, Message extends ServerMessage>(type: Type, parameters: SelectParametersForType<Type, Message>): void {
        const msg: ServerMessageBase<Type, typeof parameters> = {
            version: '2',
            type,
            id: this.id,
            seq: ++this.seq,
            clientseq: this.clientseq,
            parameters
        };
        this.sendMessage(msg as ServerMessage);
    }

    sendMessage(message: ServerMessage): void {
        this.emit('serverMessage', message);
        const json = JSON.stringify(message);
        this.logger.debug(`sendMessage - ${json.substring(0, 2048)}`);
        this.ws.send(json);
    }

    signalError(error: Error): void;
    signalError(message: string): void;
    signalError(message: string, error: Error): void;
    signalError(messageOrError: Error | string, error?: Error): void {
        try {
            let info;
            if (messageOrError instanceof Error) {
                info = `Server error: ${messageOrError.message}`;
            } else if (error) {
                info = `${messageOrError}: ${error.message}`;
            } else {
                info = messageOrError;
            }
            if (suppressErrorSignalStateMap[this.state]) {
                this.logger.warn(`Server error signaling suppressed in state ${this.state}: ${info}`);
            } else {
                this.logger.warn(`Server error (state: ${this.state}): ${info}`);
                this.setState('SIGNALED-ERROR');
                this.buildAndSendMessage('disconnect', { reason: 'error', info: info ?? 'Internal Server Error' });
            }
        } catch (err) {
            this.logger.error(`signalError - Error signaling error: ${normalizeError(err).stack}`);
        }
    }

    signalClientError(info: string): void {
        try {
            if (suppressErrorSignalStateMap[this.state]) {
                this.logger.warn(`Client error signaling suppressed in state ${this.state}: ${info}`);
            } else {
                this.logger.warn(`Signaling error (state: ${this.state}): ${info}`);
                this.setState('SIGNALED-ERROR');
                this.buildAndSendMessage('disconnect', { reason: 'error', info: `Client Error: ${info}` });
            }
        } catch (err) {
            this.logger.error(`signalClientError - Error signaling error: ${normalizeError(err).stack}`);
        }
    }

    onTextMessage(data: string): void {
        if (data.length > 65535) {
            return this.signalClientError(`Text message too large (>64K). Length: ${data.length}`);
        }
        let message;
        try {
            message = JSON.parse(data);
        } catch (error) {
            this.logger.warn(`onTextMessage - Error parsing message as JSON (${normalizeError(error).message}). Data: ${JSON.stringify(data.substring(0, 512))}`);
            return this.signalClientError('Text message not valid JSON');
        }

        if (!isClientMessageBase(message)) {
            // Note: This does not check whether it's a message type we support; we do that below.
            this.logger.warn(`onTextMessage - Message not a valid client message: ${data.substr(0, 2048)}}`);
            return this.signalClientError('Message not a well-formed client message');
        }
        if (message.seq !== this.clientseq + 1) {
            this.logger.warn(`onTextMessage - Sequence number mismatch. CurClientseq=${this.clientseq}, message.seq=${message.seq} (Type: ${message.type})`);
            return this.signalClientError('Invalid seq value (not monotonically increasing)');
        }
        this.clientseq = message.seq;

        if (message.serverseq > this.seq) {
            // The serverseq reported by the client can't be higher than what we sent out.
            this.logger.warn(`onTextMessage - Client message serverseq (${message.serverseq}) is higher than servers's seq (${this.seq})`);
            return this.signalClientError('Invalid serverseq value');
        }

        if (message.id !== this.id) {
            if (isNullUuid(this.id)) {
                // ID wasn't set and this is the first message. Set it now!
                this.id = message.id;
            } else {
                this.logger.warn(`onTextMessage - Session id mismatch. Expected=${this.id}, Message: ${message.id}`);
                return this.signalClientError('Session identifier mismatch');
            }
        }

        if (!isClientMessage(message)) {
            if (isClientMessageType(message.type)) {
                // It's a client message we know, but the parameters are bad
                this.logger.warn(`onTextMessage - Invalid '${message.type}' message (parameters bad): ${JSON.stringify(message.parameters).substr(0, 1024)}`);
                return this.signalClientError('Invalid Message: Invalid/missing parameters');
            } else {
                // it's not a client message type we know
                this.logger.warn(`onTextMessage - Unknown client message type: '${message.type}'`);
                return this.signalClientError(`Invalid Message: '${message.type}' is not a supported client message`);
            }
        }
        // 모든 유효성 검사를 통과한 제어 메시지를 로그로 출력
        try {
            this.logger.info(`Control message: ${JSON.stringify(message).substring(0, 2048)}`);
        } catch { /* ignore stringify errors */ }

        this.emit('clientMessage', message);
        this.messageDispatch[message.type](message as never);
    }

    onBinaryMessage(data: Uint8Array): void {
        this.logger.trace(`Binary message. Size: ${data.length}`);

        if (this.state !== 'ACTIVE') {
            this.signalClientError(`Received audio in state ${this.state}`);
            return;
        }
        if (!this.selectedMedia) {
            this.signalClientError('Unexpected binary message: No media selected');
            return;
        }

        let audioFrame;
        try {
            audioFrame = mediaDataFrameFromMessage(data, this.selectedMedia);
        } catch (err) {
            const info = `Binary data not a valid audio frame. Error: ${normalizeError(err).message}`;
            this.logger.warn(info);
            this.signalClientError(info);
            return;
        }
        this.position = this.position.withAddedSamples(audioFrame.sampleCount, audioFrame.rate);
        this.onAudioData(audioFrame);
    }

    onOpenMessage(message: OpenMessage): void {
        this.logger.debug(`onOpenMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state !== 'PREPARING') {
            this.logger.warn(`onOpenMessage - Ignoring 'open' message in state ${this.state}`);
            return;
        }
        this.setState('OPENING');

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const session = this;
        let discardTo: StreamDuration | null = null;
        const openContext: OpenTransactionContext = {
            session,

            get openParams() {
                return message.parameters;
            },
            get selectedMedia() {
                return session.selectedMedia;
            },

            setStartPaused(value: boolean) {
                session.startPaused = value;
            },

            setDiscardTo(value: StreamDuration) {
                if ((discardTo === null) || (value.nanoseconds < discardTo.nanoseconds)) {
                    discardTo = value;
                }
            },
        };

        /* eslint-disable @typescript-eslint/indent */
        this.openTransactionPromise = (
            this.runAuthenticators(message)
                .then<true | void>(() => {
                    if (this.state === 'OPENING') {
                        return this.runMediaSelectors(message);
                    } else {
                        this.logger.info(`onOpenMessage - State changed to ${this.state} during authentication`);
                        return true;
                    }
                })
                .then<true | void>((logged) => {
                    if (this.state === 'OPENING') {
                        this.logger.info(`onOpenMessage - Selected media: ${JSON.stringify(this.selectedMedia)}`);
                        return this.runSupportedLanguages(message);
                    } else {
                        if (!logged) {
                            this.logger.info(`onOpenMessage - State changed to ${this.state} during media selection`);
                        }
                        return true;
                    }
                })
                .then<true | void>((logged) => {
                    if (this.state === 'OPENING') {
                        if (this.sendSupportedLanguages) {
                            this.logger.info(`onOpenMessage - Send supported languages: ${JSON.stringify(this.supportedLanguages)}`);
                        }
                        return this.runOpenHandlers(openContext);
                    } else {
                        if (!logged) {
                            this.logger.info(`onOpenMessage - State changed to ${this.state} while checking if the supported languages were required`);
                        }
                        return true;
                    }
                })
                .then((logged) => {
                    if (this.state === 'OPENING') {
                        this.logger.info('onOpenMessage - Open handlers complete, session opened');
                        const openedParams: OpenedParameters = {
                            media: this.selectedMedia ? [this.selectedMedia] : [],
                            startPaused: this.startPaused
                        };
                        if ((discardTo !== null) && (discardTo.nanoseconds > this.position.nanoseconds)) {
                            openedParams.discardTo = discardTo.asDuration();
                        }
                        if (this.sendSupportedLanguages) {
                            openedParams.supportedLanguages = this.supportedLanguages ? this.supportedLanguages : [];
                        }
                        this.buildAndSendMessage('opened', openedParams);
                        this.setState('ACTIVE');
                        // 활성화되면 오디오 녹음 준비 시작
                        try {
                            this.startAudioRecording();
                        } catch (e) {
                            this.logger.warn(`startAudioRecording trigger failed: ${normalizeError(e).message}`);
                        }
                    } else if (!logged) {
                        this.logger.info(`onOpenMessage - State changed to ${this.state} during open handlers`);
                    }
                })
                .catch(err => {
                    const error = normalizeError(err);
                    this.logger.error(`onOpenMessage - Error during open transaction: ${error.stack}`);
                    this.signalError(error);
                })
        );
        /* eslint-enable @typescript-eslint/indent */
    }

    onUpdateMessage(message: UpdateMessage): void {
        this.logger.info(`onUpdateMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state !== 'ACTIVE' && this.state !== 'PAUSED') {
            this.logger.warn(`onUpdateMessage - Ignoring 'update' message in state ${this.state}`);
            return;
        }
        this.runUpdateHandlers(message.parameters);
        this.emit('update', message.parameters);
    }

    onCloseMessage(message: CloseMessage): void {
        this.logger.debug(`onCloseMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'CLOSING') {
            this.logger.info(`onCloseMessage - Ignoring message in state ${this.state}`);
            return;
        }

        // Note: Close transaction is pretty much OK in any state (other than if we're already closing)
        // TODO: Do we need to behave differently if state is UNAUTHORIZED?
        this.logger.info(`onCloseMessage - Closing session (state: ${this.state})...`);
        this.setState('CLOSING');
        (this.openTransactionPromise ?? Promise.resolve())
            .finally(() => {
                return this.runCloseHandlers(message.parameters);
            })
            .finally(() => {
                this.logger.info('onCloseMessage - Close handlers completed, session closed');
                if (this.state === 'CLOSING') {
                    this.buildAndSendMessage('closed', {});
                    this.setState('CLOSED');
                }
            });
    }

    onErrorMessage(message: ErrorMessage): void {
        this.logger.warn(`onErrorMessage - ${JSON.stringify(message, null, 1)}`);
        this.emit('error', message.parameters);
    }

    onPingMessage(message: PingMessage): void {
        this.logger.debug(`onPingMessage - RTT: ${message.parameters.rtt ?? ''}`);
        this.buildAndSendMessage('pong', {});
        this.lastPingTimestamp = process.hrtime.bigint();
        if (message.parameters.rtt) {
            const info: StatisticsInfo = {
                rtt: StreamDuration.fromDuration(message.parameters.rtt)
            };
            this.emit('statistics', info);
        }
    }

    onDiscardedMessage(message: DiscardedMessage): void {
        this.logger.debug(`onDiscardedMessage - ${JSON.stringify(message, null, 1)}`);
        this.emit('discarded', message.parameters);
    }

    onPausedMessage(message: PausedMessage): void {
        this.logger.debug(`onPausedMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'ACTIVE') {
            this.setState('PAUSED');
            this.emit('paused');
        } else {
            this.logger.warn(`onPausedMessage - Ignoring 'pause' message in state ${this.state}`);
        }
    }

    onResumedMessage(message: ResumedMessage): void {
        this.logger.debug(`onResumedMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'PAUSED') {
            this.setState('ACTIVE');
            this.emit('resumed', message.parameters);
        } else {
            this.logger.warn(`onResumedMessage - Ignoring 'resume' message in state ${this.state}`);
        }
    }

    onAudioData(frame: MediaDataFrame): void {
        // 파일 저장 기능이 비활성화된 경우 저장을 우회
        if (!this.fileRecordingEnabled) {
            this.emit('audio', frame);
            // STT 포워딩
            void this.ensureSttForwarder().then(() => this.sttForwarder?.send(frame)).catch(() => void 0);
            return;
        }
        // 오디오 파일 작성기가 준비되지 않았다면 시작 시도
        if (!this.audioWriter && !this.audioWriterPromise) {
            try {
                this.startAudioRecording();
            } catch (e) {
                this.logger.warn(`startAudioRecording (onAudioData) failed: ${normalizeError(e).message}`);
            }
        }
        const writer = this.audioWriter;
        if (writer) {
            try {
                // 멀티채널 인터리브된 프레임 데이터를 그대로 기록
                writer.writeAudio(frame.audio.data as unknown as Uint8Array | Int16Array);
            } catch (err) {
                this.logger.warn(`onAudioData - Error writing audio: ${normalizeError(err).message}`);
                // 쓰기 오류 발생 시 자동 회전 시도
                if (!this.isRotating) {
                    void this.rotateRecordingFile();
                }
            }
        } else if (this.audioWriterPromise) {
            // 작성기 준비 중이면 큐에 보관
            this.pendingAudioFrames.push(frame);
        }
        // STT 포워딩
        void this.ensureSttForwarder().then(() => this.sttForwarder?.send(frame)).catch(() => void 0);
        this.emit('audio', frame);
    }

    async runAuthenticators(message: OpenMessage): Promise<void> {
        for (let handler = this.authenticators.shift(); (handler && (this.state === 'OPENING')); handler = this.authenticators.shift()) {
            try {
                // We allow handlers to fail the authentication by returning false, a non-empty string, or invoke disconnect() with 'unauthorized' itself.
                // Errors are signaled as regular server error (disconnect with reason 'error')
                const result = await handler(this, message.parameters);
                if (this.state !== 'OPENING') {
                    // State changed while we were out, we're done here.
                    break;
                }
                if (typeof result === 'boolean') {
                    if (!result) {
                        this.disconnect('unauthorized');
                    }
                } else if (typeof result === 'string') {
                    if (result.length !== 0) {
                        this.disconnect('unauthorized', result);
                    }
                }
            } catch (err) {
                const error = normalizeError(err);
                this.logger.error(`runAuthenticators - Error running authentication handler: ${error.stack}`);
                this.signalError(error);
            }
        }
    }

    async runMediaSelectors(message: OpenMessage): Promise<void> {
        let offered = message.parameters.media;
        for (let handler = this.mediaSelectors.shift(); (handler && (this.state === 'OPENING')); handler = this.mediaSelectors.shift()) {
            offered = await handler(this, offered, message.parameters);
        }
        if (this.state === 'OPENING') {
            // Pick the first media format from the ones that survived the selectors' filters.
            // If there weren't any media selectors, this will just pick the first offered.
            this.selectedMedia = offered[0] ?? null;
        }
    }

    async runSupportedLanguages(message: OpenMessage): Promise<void> {
        if (this.state === 'OPENING') {
            this.sendSupportedLanguages = message.parameters.supportedLanguages ?? false;
        }
    }

    async runOpenHandlers(openContext: OpenTransactionContext): Promise<void> {
        // Run all open handlers. We allow registering of open handlers while other open handlers run.
        // So we just run through the list until the list is empty.
        this.language = openContext.openParams.language?.toLowerCase() ?? null;
        while ((this.openHandlers.length !== 0) && (this.state === 'OPENING')) {
            // Note: we initiate all handlers in parallel and then wait for the promises to settle
            const promises: Array<PromiseLike<CloseHandler | void>> = [];
            for (let handler = this.openHandlers.shift(); handler; handler = this.openHandlers.shift()) {
                try {
                    const result = handler(openContext);
                    if (isPromise(result)) {
                        promises.push(result);
                    } else if (result) {
                        this.closeHandlers.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            let err: unknown = null;
            results.forEach(result => {
                if (result.status === 'rejected') {
                    err = result.reason;
                } else if (result.value) {
                    this.closeHandlers.push(result.value);
                }
            });
            if (err) {
                throw err;  // Rethrow the last one
            }
        }
    }

    // Update Handlers should run as many times as we get the update message
    async runUpdateHandlers(updateParams: UpdateParameters | null): Promise<void> {
        this.language = updateParams?.language?.toLowerCase() ?? null;
        for (let i = 0; i < this.updateHandlers.length; i++) {
            this.updateHandlers[i](this, updateParams);
        }
    }

    async runCloseHandlers(closeParams: CloseParameters | null): Promise<void> {
        // Run all close handlers. We allow close handlers getting added while the close handlers run.
        while (this.closeHandlers.length !== 0) {
            const promises: Array<PromiseLike<FiniHandler | void>> = [];
            for (let handler = this.closeHandlers.shift(); handler; handler = this.closeHandlers.shift()) {
                try {
                    const result = handler(this, closeParams);
                    if (isPromise(result)) {
                        promises.push(result);
                    } else if (result) {
                        this.finiHandlers.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            results.forEach(result => {
                if (result.status === 'rejected') {
                    this.logger.warn(`Error executing close handler: ${normalizeError(result.reason).stack}`);
                } else if (result.value) {
                    this.finiHandlers.push(result.value);
                }
            });
        }
    }

    async runFiniHandlers(): Promise<void> {
        while (this.finiHandlers.length !== 0) {
            const promises: Array<PromiseLike<void>> = [];
            for (let handler = this.finiHandlers.shift(); handler; handler = this.finiHandlers.shift()) {
                try {
                    const result = handler(this);
                    if (isPromise(result)) {
                        promises.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            results.forEach(result => {
                if (result.status === 'rejected') {
                    this.logger.warn(`Error executing fini handler: ${normalizeError(result.reason).stack}`);
                }
            });
        }
    }

    private startAudioRecording(): void {
        if (!this.fileRecordingEnabled) {
            this.logger.info('startAudioRecording - File recording disabled by configuration');
            return;
        }
        if (this.audioWriter || this.audioWriterPromise) {
            return; // already starting or started
        }
        const media = this.selectedMedia;
        if (!media) {
            this.logger.warn('startAudioRecording - No selected media; cannot start recording');
            return;
        }
        try {
            const dir = this.fileRecordingRoot;
            const filename = `${String(this.id)}_${Date.now()}.wav`;
            const fullPath = join(dir, filename);
            this.recordingFilePath = fullPath;
            this.audioWriterPromise = mkdir(dir, { recursive: true })
                .then(() => WavFileWriter.create(fullPath, media.format, media.rate, media.channels.length))
                .then(writer => {
                    this.audioWriter = writer;
                    this.logger.info(`Audio recording started: ${fullPath} (${media.format}, ${media.rate}Hz, ${media.channels.length}ch)`);
                    // 대기 중인 프레임을 즉시 기록
                    const queued = this.pendingAudioFrames;
                    this.pendingAudioFrames = [];
                    for (const f of queued) {
                        try {
                            writer.writeAudio(f.audio.data as unknown as Uint8Array | Int16Array);
                        } catch (err) {
                            this.logger.warn(`startAudioRecording - Error writing queued frame: ${normalizeError(err).message}`);
                        }
                    }
                    // 파일 유실 감시 시작
                    this.startRecordingWatch();
                    return writer;
                })
                .catch(err => {
                    const error = normalizeError(err);
                    this.logger.error(`startAudioRecording - Failed to initialize WAV writer: ${error.stack}`);
                    this.audioWriterPromise = null;
                    this.recordingFilePath = null;
                    // 기록 실패 시 큐는 버퍼로 남지만 더 이상 진행하지 않음
                    return null;
                });

            // 세션 종료 시 파일을 닫도록 close 핸들러 등록
            this.closeHandlers.push(async () => {
                try {
                    const p = this.audioWriterPromise;
                    if (p) {
                        const w = await p;
                        if (w) {
                            const samples = await w.close();
                            this.logger.info(`Audio recording closed (${samples} samples)${this.recordingFilePath ? `: ${this.recordingFilePath}` : ''}`);
                        }
                    } else if (this.audioWriter) {
                        const samples = await this.audioWriter.close();
                        this.logger.info(`Audio recording closed (${samples} samples)${this.recordingFilePath ? `: ${this.recordingFilePath}` : ''}`);
                    }
                } catch (err) {
                    this.logger.warn(`Error closing audio recording: ${normalizeError(err).stack}`);
                } finally {
                    this.audioWriter = null;
                    this.audioWriterPromise = null;
                    this.pendingAudioFrames = [];
                    this.recordingFilePath = null;
                    this.stopRecordingWatch();
                }
            });
        } catch (err) {
            this.logger.error(`startAudioRecording - Unexpected error: ${normalizeError(err).stack}`);
        }
    }

    private startRecordingWatch(): void {
        this.stopRecordingWatch();
        if (!this.recordingFilePath) {
            return;
        }
        // 2초마다 파일 존재 여부를 확인하고, 없으면 회전
        this.recordingWatchTimer = setInterval(() => {
            try {
                const path = this.recordingFilePath;
                if (!path) {
                    return;
                }
                if (!existsSync(path)) {
                    this.logger.warn(`Recording file missing. Rotating to new file. path=${path}`);
                    if (!this.isRotating) {
                        void this.rotateRecordingFile();
                    }
                }
            } catch (e) {
                this.logger.warn(`startRecordingWatch - check failed: ${normalizeError(e).message}`);
            }
        }, 2000);
    }

    private stopRecordingWatch(): void {
        if (this.recordingWatchTimer) {
            clearInterval(this.recordingWatchTimer);
            this.recordingWatchTimer = null;
        }
    }

    private async rotateRecordingFile(): Promise<void> {
        if (this.isRotating) {
            return;
        }
        this.isRotating = true;
        if (!this.fileRecordingEnabled) {
            this.isRotating = false;
            return;
        }
        // 닫고 새 파일로 재시작
        try {
            if (this.audioWriter) {
                const samples = await this.audioWriter.close();
                this.logger.info(`Recording rotated, old file closed (${samples} samples)`);
            } else if (this.audioWriterPromise) {
                const w = await this.audioWriterPromise;
                if (w) {
                    const samples = await w.close();
                    this.logger.info(`Recording rotated, old file closed (${samples} samples)`);
                }
            }
        } catch (e) {
            this.logger.warn(`rotateRecordingFile - error closing old file: ${normalizeError(e).message}`);
        }
        this.audioWriter = null;
        this.audioWriterPromise = null;
        this.pendingAudioFrames = [];
        this.recordingFilePath = null;
        // 새 파일 시작
        try {
            this.startAudioRecording();
        } finally {
            this.isRotating = false;
        }
    }

    private async ensureSttForwarder(): Promise<void> {
        if (!sttConfig.enabled) {
            return;
        }
        if (this.sttForwarder) {
            return;
        }
        if (this.sttForwarderPromise) {
            await this.sttForwarderPromise;
            return;
        }
        this.sttForwarderPromise = (async () => {
            const fwd = createSttForwarder(sttConfig.protocol, this.logger);
            await fwd.start();
            this.sttForwarder = fwd;
            return fwd;
        })().catch(err => {
            this.logger.warn(`Failed to start STT forwarder: ${normalizeError(err).message}`);
            return null;
        }).finally(() => {
            this.sttForwarderPromise = null;
        });
        await this.sttForwarderPromise;
    }

    private async restartSttForwarderIfNeeded(force = false): Promise<void> {
        if (!sttConfig.enabled) {
            // ensure any in-progress start finishes, then stop
            if (this.sttForwarderPromise) {
                await this.sttForwarderPromise;
            }
            if (this.sttForwarder) {
                await this.sttForwarder.stop();
                this.sttForwarder = null;
            }
            return;
        }
        // wait for any in-progress start
        if (this.sttForwarderPromise) {
            await this.sttForwarderPromise;
        }
        if (force && this.sttForwarder) {
            await this.sttForwarder.stop();
            this.sttForwarder = null;
        }
        if (!this.sttForwarder) {
            const fwd = createSttForwarder(sttConfig.protocol, this.logger);
            await fwd.start();
            this.sttForwarder = fwd;
        }
    }

    override emit(eventName: 'paused', ...args: Parameters<OmitThisParameter<OnPausedHandler>>): boolean;
    override emit(eventName: 'resumed', ...args: Parameters<OmitThisParameter<OnResumedHandler>>): boolean;
    override emit(eventName: 'audio', ...args: Parameters<OmitThisParameter<OnAudioHandler>>): boolean;
    override emit(eventName: 'discarded', ...args: Parameters<OmitThisParameter<OnDiscardedHandler>>): boolean;
    override emit(eventName: 'update', ...args: Parameters<OmitThisParameter<OnUpdateHandler>>): boolean;
    override emit(eventName: 'error', ...args: Parameters<OmitThisParameter<OnErrorHandler>>): boolean;
    override emit(eventName: 'statistics', ...args: Parameters<OmitThisParameter<OnStatisticsHandler>>): boolean;
    override emit(eventName: 'serverMessage', ...args: Parameters<OmitThisParameter<OnServerMessageHandler>>): boolean;
    override emit(eventName: 'clientMessage', ...args: Parameters<OmitThisParameter<OnClientMessageHandler>>): boolean;
    override emit(eventName: string, ...args: unknown[]): boolean {
        if (this.listenerCount(eventName) > 0) {
            return super.emit(eventName, ...args);
        }
        return false;
    }
}
