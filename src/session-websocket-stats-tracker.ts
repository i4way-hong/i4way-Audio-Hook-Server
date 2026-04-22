import { 
    MediaParameter,
    OnAudioHandler,
    OnDiscardedHandler,
    OnResumedHandler,
    OpenHandler,
    ServerWebSocket,
    StreamDuration,
    JsonObject,
    Duration,
} from '../audiohook';


export type SessionWebsocketStatsTrackerSummary = {
    timing: {
        start: string;
        open: Duration;
        close: Duration;
    },
    transport: {
        sent: {
            text: number;
            binary: number;
        },
        received: {
            text: number;
            binary: number;
        }
    },
    audio: {
        selectedMedia: MediaParameter | null;
        positions: {
            start: Duration; 
            last: Duration;
            end: Duration;
        },
        durations: {
            audio: Duration;
            discarded: Duration;
            paused: Duration;
        }
    }
};

const logTimezonePreference = process.env['LOG_TIMEZONE'];

const buildTimestampFormatter = (preferredTimezone?: string): Intl.DateTimeFormat => {
    const baseOptions: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'shortOffset'
    };

    if(preferredTimezone) {
        try {
            return new Intl.DateTimeFormat('en-CA', { ...baseOptions, timeZone: preferredTimezone });
        } catch (error) {
            console.warn(`Invalid LOG_TIMEZONE value "${preferredTimezone}". Falling back to server timezone.`, error);
        }
    }

    return new Intl.DateTimeFormat('en-CA', baseOptions);
};

const timestampFormatter = buildTimestampFormatter(logTimezonePreference);

const formatTimestamp = (timestamp: number): string => {
    if(!Number.isFinite(timestamp) || timestamp <= 0) {
        return 'n/a';
    }

    const parts = timestampFormatter.formatToParts(new Date(timestamp));
    const lookup = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
    const timeZoneName = lookup('timeZoneName');
    const fractional = Math.floor(timestamp % 1000).toString().padStart(3, '0');

    return `${lookup('year')}-${lookup('month')}-${lookup('day')} ${lookup('hour')}:${lookup('minute')}:${lookup('second')}.${fractional.padEnd(3, '0')} ${timeZoneName}`.trim();
};

export class SessionWebsocketStatsTracker implements ServerWebSocket {
    readonly ws: ServerWebSocket;
    readonly startTimestamp: number;
    openTimestamp = 0;
    closeTimestamp = 0;

    bytesSentText = 0;
    bytesSentBinary = 0;
    bytesReceivedText = 0;
    bytesReceivedBinary = 0;

    selectedMedia: MediaParameter | null = null;
    startPosition: StreamDuration = StreamDuration.zero;
    lastPosition: StreamDuration = StreamDuration.zero;
    endPosition: StreamDuration = StreamDuration.zero;
    durationAudio: StreamDuration = StreamDuration.zero;
    durationDiscarded: StreamDuration = StreamDuration.zero;
    durationPaused: StreamDuration = StreamDuration.zero;

    constructor(ws: ServerWebSocket) {
        this.startTimestamp = Date.now();
        this.ws = ws;
        this.ws.on('message', (data, isBinary) => {
            if(isBinary) {
                this.bytesReceivedBinary += data.byteLength;
            } else {
                this.bytesReceivedText += data.byteLength;
            }
        });
    }

    createTrackingHandler(): OpenHandler {
        return ({ session, selectedMedia }) => {
            this.openTimestamp = Date.now();
            this.startPosition = session.position;
            this.selectedMedia = selectedMedia;
            
            const resumeHandler: OnResumedHandler = (parameter) => {
                this.durationPaused = this.durationPaused.withAddedDuration(parameter.discarded);
                this.lastPosition = session.position;
            };

            const discardedHandler: OnDiscardedHandler = (parameter) => {
                this.durationDiscarded = this.durationDiscarded.withAddedDuration(parameter.discarded);
                this.lastPosition = session.position;
            };

            const audioHandler: OnAudioHandler = (frame) => {
                const duration = StreamDuration.fromSamples(frame.sampleCount, frame.rate);
                this.durationAudio = this.durationAudio.withAdded(duration);
                this.lastPosition = this.lastPosition.withAdded(duration);
            };

            session.on('resumed', resumeHandler);
            session.on('discarded', discardedHandler);
            session.on('audio', audioHandler);

            return () => {
                this.closeTimestamp = Date.now();
                this.endPosition = session.position;
                session.off('resumed', resumeHandler);
                session.off('discarded', discardedHandler);
                session.off('audio', audioHandler);
            };
        };
    }

    jsonSummary(): JsonObject {
        return this.summary();
    }

    summary(): SessionWebsocketStatsTrackerSummary {
        return {
            timing: {
                start: formatTimestamp(this.startTimestamp), 
                open: StreamDuration.fromMilliseconds(Math.max(0, this.openTimestamp - this.startTimestamp)).asDuration(),
                close: StreamDuration.fromMilliseconds(Math.max(0, this.closeTimestamp - this.startTimestamp)).asDuration(),
            },
            transport: {
                sent: {
                    text: this.bytesSentText,
                    binary: this.bytesSentBinary
                },
                received: {
                    text: this.bytesReceivedText,
                    binary: this.bytesReceivedBinary
                }
            },
            audio: {
                selectedMedia: this.selectedMedia,
                positions: {
                    start: this.startPosition.asDuration(),
                    last: this.lastPosition.asDuration(),
                    end: this.endPosition.asDuration(),
                },
                durations: {
                    audio: this.durationAudio.asDuration(),
                    discarded: this.durationDiscarded.asDuration(),
                    paused: this.durationPaused.asDuration(),
                }
            }
        };

    }

    loggableSummary(): string {
        return (
            `start: ${formatTimestamp(this.startTimestamp)}, `+
            `open: ${StreamDuration.fromMilliseconds(Math.max(0, this.openTimestamp - this.startTimestamp)).asDuration()}, `+
            `close: ${StreamDuration.fromMilliseconds(Math.max(0, this.closeTimestamp - this.startTimestamp)).asDuration()}, `+
            `received: ${this.bytesReceivedText+this.bytesReceivedBinary}, `+
            `sent: ${this.bytesSentText+this.bytesSentBinary}, `+
            `pos: {start: ${this.startPosition.asDuration()}, end: ${this.endPosition.asDuration()}}, `+
            `audio: {duration: ${this.durationAudio.asDuration()}, discarded: ${this.durationDiscarded.asDuration()}, paused: ${this.durationPaused.asDuration()}}`
        );
    }

    close() {
        this.ws.close();
    }

    send(data: string | Uint8Array) {
        if(data instanceof Uint8Array) {
            this.bytesSentBinary += data.byteLength;
        } else {
            this.bytesSentText += Buffer.byteLength(data, 'utf8');
        }
        this.ws.send(data);
    }

    on(event: 'close', listener: (this: ServerWebSocket, code: number) => void): this;
    on(event: 'error', listener: (this: ServerWebSocket, err: Error) => void): this;
    on(event: 'message', listener: (this: ServerWebSocket, data: Uint8Array, isBinary: boolean) => void): this;
    on(...args: unknown[]): this {
        this.ws.on(...args as Parameters<ServerWebSocket['on']>);
        return this;
    }
}
