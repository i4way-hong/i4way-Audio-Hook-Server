# AudioHook STT 연동 기술 명세서 (상세)

**버전: 1.1**
**최종 업데이트: 2025-11-25**

## 1. 개요

이 문서는 AudioHook 서버와 외부 음성 인식(STT) 엔진 간의 실시간 오디오 스트림 연동을 위한 기술 명세를 상세히 정의합니다. AudioHook 서버는 컨택센터 등에서 발생한 오디오 스트림을 수신하여, 본 명세에 따라 STT 엔진으로 전달하는 역할을 수행합니다.

STT 업체는 이 명세에 정의된 프로토콜 중 하나를 구현하여 AudioHook 서버로부터 오디오 데이터를 수신하고, 인식 결과를 반환해야 합니다.

### 1.1. 용어 정의
- **AudioHook 서버**: 클라이언트로부터 오디오를 수신하여 STT 엔진으로 전달하는 중계 서버.
- **STT 엔진**: 음성 데이터를 텍스트로 변환하는 외부 서비스.
- **세션**: 클라이언트와 AudioHook 서버 간의 단일 통화 또는 오디오 스트림 단위.

## 2. 공통 사항

### 2.1. 오디오 포맷
- **코덱**:
  - `LINEAR16`: 16-bit Signed Integer PCM, Little-endian.
  - `PCMU`: G.711 μ-law.
- **샘플 레이트 (Sample Rate)**: 8000 Hz 또는 16000 Hz.
- **채널 (Channels)**: Mono (단일 채널).
- **리샘플링**: AudioHook 서버는 수신된 오디오의 샘플 레이트가 STT 엔진 요구사항과 다를 경우, 설정된 값(`STT_RATE`)으로 자동 리샘플링하는 기능을 지원합니다. (`STT_RESAMPLE_ENABLED=true`)

### 2.2. 재연결
- STT 엔진과의 연결이 비정상적으로 끊어질 경우, AudioHook 서버는 설정된 정책(`STT_RECONNECT_...` 변수들)에 따라 자동으로 재연결을 시도합니다. STT 엔진은 동일한 세션 ID로 재연결이 들어올 경우, 기존 컨텍스트를 이어받아 처리할 수 있어야 합니다.

---

## 3. WebSocket 프로토콜 명세 (권장)

실시간 양방향 통신에 적합하며, JSON 기반의 유연한 메시지 교환이 가능합니다.

### 3.1. 연결 및 인증
- **Endpoint URL**: AudioHook 서버의 `.env` 파일 내 `STT_ENDPOINT`에 지정된 WebSocket URL로 연결을 시도합니다. (예: `wss://stt.example.com/v1/stream`)
- **인증 (Authentication)**:
  - HTTP Header에 API Key 또는 인증 토큰을 포함하여 인증을 수행합니다.
  - AudioHook 서버는 다음 환경 변수를 사용하여 헤더를 구성합니다.
    - `STT_API_KEY`: `Authorization: Bearer {STT_API_KEY}` 헤더를 자동으로 추가합니다.
    - `STT_HEADERS`: 추가적인 커스텀 헤더를 JSON 형식으로 정의할 수 있습니다. (예: `{"X-Client-ID": "audiohook-server"}`)

### 3.2. 메시지 흐름도
```
+-----------------+                            +-----------+
| AudioHook 서버  |                            | STT 엔진  |
+-----------------+                            +-----------+
        |                                              |
        |  1. WebSocket 연결 요청 (Handshake)          |
        |  (인증 헤더 포함)                            |
        |--------------------------------------------->|
        |                                              |
        |  2. 초기 설정 메시지 (Init Message) 전송     |
        |  (JSON Text Frame)                           |
        |--------------------------------------------->|
        |                                              |
        |  3. 오디오 데이터 (Binary/JSON) 전송         |
        |  (세션 동안 반복)                            |
        |--------------------------------------------->|
        |                                              |
        |  4. 전사 결과 (Text) 수신                    |
        |  (JSON Text Frame)                           |
        |<---------------------------------------------|
        |  (STT 엔진이 결과 생성 시마다)               |
        |                                              |
        |  5. 종료 메시지 (Bye Message) 전송 (선택)    |
        |  (JSON Text Frame)                           |
        |--------------------------------------------->|
        |                                              |
        |  6. 연결 종료                                |
        |==============================================|
```

### 3.3. 메시지 포맷 (AudioHook → STT 엔진)

#### 3.3.1. 초기 설정 메시지 (Init Message)
- **시점**: WebSocket 연결이 성공적으로 수립된 직후, 첫 오디오 데이터 전송 전.
- **목적**: 오디오 스트림의 포맷, 샘플 레이트 및 세션 컨텍스트 정보를 STT 엔진에 전달합니다.
- **형식**: WebSocket Text Frame (JSON).
- **내용**: `STT_WS_INIT_JSON` 환경 변수에 정의된 기본 JSON 객체에, AudioHook 세션의 컨텍스트 정보(`conversationId`, `conversation_lookup` 등)가 자동으로 병합되어 전송됩니다.
- **STT 엔진 구현**: STT 엔진은 이 메시지를 파싱하여 해당 세션의 오디오 처리 방식을 결정해야 합니다.
- **컨텍스트 정보 필터링**: `CONTEXT_FIELDS` 환경 변수를 사용하여 STT 엔진으로 전달할 필드를 지정할 수 있습니다. 콤마(`,`)로 구분된 필드 이름 목록을 값으로 가집니다. (예: `ani,dnis,uui`) 이 변수가 설정되면, AudioHook 세션의 초기 정보에서 해당 필드들만 추출하여 `conversationLookup` 배열로 만들어 전송합니다.

**`STT_WS_INIT_JSON` 설정 예시:**
```json
{
  "config": {
    "encoding": "LINEAR16",
    "sample_rate_hertz": 16000,
    "language_code": "ko-KR",
    "enable_automatic_punctuation": true
  },
  "user_id": "audiohook-server"
}
```

**실제 전송되는 메시지 예시 (컨텍스트 정보 병합 후):**
```json
{
  "config": {
    "encoding": "LINEAR16",
    "sample_rate_hertz": 16000,
    "language_code": "ko-KR",
    "enable_automatic_punctuation": true
  },
  "user_id": "audiohook-server",
  "conversationId": "a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6",
  "conversationLookup": [
    { "key": "customer_grade", "value": "VIP" },
    { "key": "inbound_number", "value": "1588-0000" }
  ]
}
```

#### 3.3.2. 오디오 데이터
- **시점**: 초기 설정 메시지 전송 후, 세션이 활성화된 동안 지속적으로 전송.
- **전송 모드 (`STT_WS_MODE` 환경 변수로 제어)**:
  - **`binary` (기본값)**:
    - **형식**: WebSocket Binary Frame.
    - **내용**: 순수 오디오 데이터 (L16 또는 PCMU). 예를 들어, 16kHz 16bit 오디오 데이터 20ms 분량은 640 bytes (`16000 * 2 * 0.020`) 크기의 바이너리 데이터로 전송됩니다.
    - **실제 데이터 예시 (16진수 표현)**: `0x1A, 0x01, 0xFB, 0xFF, 0x3C, 0x00, ... (640 bytes)`

  - **`json-base64`**:
    - **형식**: WebSocket Text Frame (JSON).
    - **내용**: 오디오 데이터를 Base64로 인코딩하여 JSON 객체에 담아 전송합니다.
    - **JSON 필드**: 오디오 데이터가 포함될 필드명은 `STT_WS_JSON_AUDIO_KEY` 환경 변수로 지정할 수 있습니다 (기본값: `audio`).
    - **실제 데이터 예시**:
      ```json
      {
        "audio": "GgH/v/88AAB... (위 바이너리 데이터를 Base64로 인코딩한 문자열)"
      }
      ```

#### 3.3.3. 종료 메시지 (Bye Message)
- **시점**: 오디오 세션이 정상적으로 종료될 때 (선택 사항).
- **형식**: WebSocket Text Frame (JSON).
- **내용**: `STT_WS_BYE_JSON` 환경 변수에 정의된 메시지를 전송하여 세션 종료를 명시적으로 알립니다.
- **실제 데이터 예시**: `{"event": "end_of_stream"}`

### 3.4. 메시지 포맷 (STT 엔진 → AudioHook)

#### 3.4.1. 전사 결과
- **시점**: STT 엔진이 음성 인식 결과를 생성할 때마다 실시간으로 전송.
- **형식**: WebSocket Text Frame (JSON).
- **내용**: AudioHook 서버는 수신된 텍스트를 파싱하여 로그에 기록하고, 추후 분석/모니터링에 활용할 수 있습니다.
- **필수 필드**:
  - `transcript` (string): 인식된 텍스트.
  - `is_final` (boolean): `true`이면 문장의 최종 인식 결과, `false`이면 중간 결과.
- **선택 필드**:
  - `confidence` (number): 인식 결과의 신뢰도 (0.0 ~ 1.0).
  - `...` (any): 그 외 STT 엔진이 제공하는 부가 정보.

**실제 데이터 예시 (중간 결과와 최종 결과):**
```json
// 중간 결과 (고객이 "네 안녕하세요" 라고 말하는 중)
{
  "transcript": "네 안녕",
  "is_final": false,
  "confidence": 0.91
}
```
```json
// 최종 결과 (발화가 끝나고 문장이 완성됨)
{
  "transcript": "네 안녕하세요.",
  "is_final": true,
  "confidence": 0.98,
  "word_timings": [
      { "word": "네", "start_time": "0.1s", "end_time": "0.3s" },
      { "word": "안녕하세요", "start_time": "0.4s", "end_time": "0.9s" }
  ]
}
```

### 3.5. Keep-Alive
- AudioHook 서버는 `STT_WS_PING_SEC` 환경 변수에 설정된 주기(초)에 따라 WebSocket `Ping` 프레임을 전송합니다. STT 엔진은 이에 대해 `Pong` 프레임으로 응답해야 합니다.

---

## 4. gRPC 프로토콜 명세 (권장)

고성능, 낮은 지연 시간이 요구되는 환경에 적합하며, Protocol Buffers를 이용한 명확한 API 스키마를 제공합니다.

### 4.1. Proto 파일
- **위치**: `proto/speech_transcription.proto`
- STT 엔진은 이 `.proto` 파일에 정의된 서비스와 메시지를 구현해야 합니다.

### 4.2. 서비스 및 메서드
- **서비스**: `SpeechTranscription`
- **메서드**: `rpc StreamingRecognize (stream StreamingRecognizeRequest) returns (stream StreamingRecognizeResponse);`
  - 클라이언트(AudioHook)와 서버(STT 엔진)가 스트림을 통해 메시지를 주고받는 **양방향 스트리밍(Bidirectional Streaming)** RPC입니다.

### 4.3. 메시지 상세 (AudioHook → STT 엔진)

#### 4.3.1. `StreamingRecognizeRequest`
- **첫 번째 메시지**: 스트림의 첫 메시지는 반드시 `init` 필드가 채워진 `StreamingRecognizeRequest`여야 합니다.
  - **`init` (`SessionInit`)**:
    - `language_code` (string): "ko-KR" 등 언어 코드.
    - `sample_rate_hz` (int32): 오디오 샘플 레이트 (예: 16000).
    - `encoding` (enum): `LINEAR16` 또는 `PCMU`.
    - `vendor_params` (map<string, string>): STT 엔진에 전달할 추가 파라미터. AudioHook은 여기에 `conversation_metadata` 키로 세션 컨텍스트 JSON 문자열을 담아 전송합니다.
    - `tags` (map<string, string>): `conversationId` 등 주요 메타데이터가 Key-Value 형태로 전달됩니다.
- **이후 메시지**: 스트림의 두 번째 메시지부터는 `audio` 필드가 채워진 `StreamingRecognizeRequest`여야 합니다.
  - **`audio` (`AudioChunk`)**:
    - `data` (bytes): 순수 오디오 바이너리 데이터.
    - `sequence` (int64): 오디오 청크의 순서 번호.

**실제 데이터 예시 (첫 번째 메시지):**
```protobuf
// 의사(pseudo) 코드 표현
StreamingRecognizeRequest {
  init: SessionInit {
    language_code: "ko-KR",
    sample_rate_hz: 16000,
    encoding: LINEAR16,
    vendor_params: {
      "conversation_metadata": "{\"customer_grade\":\"VIP\",\"inbound_number\":\"1588-0000\"}"
    },
    tags: {
      "conversationId": "a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6"
    }
  }
}
```

**실제 데이터 예시 (두 번째 이후 오디오 메시지):**
```protobuf
// 의사(pseudo) 코드 표현
StreamingRecognizeRequest {
  audio: AudioChunk {
    // 640 bytes의 L16 오디오 데이터
    data: <0x1A 0x01 0xFB 0xFF ...>,
    sequence: 1
  }
}
```

### 4.4. 메시지 상세 (STT 엔진 → AudioHook)

#### 4.4.1. `StreamingRecognizeResponse`
- STT 엔진은 인식 결과를 `StreamingRecognizeResponse` 메시지에 담아 스트림으로 전송합니다.
- **`transcript` (`Transcript`)**:
  - `text` (string): 인식된 텍스트.
  - `is_final` (bool): `true`이면 최종 결과, `false`이면 중간 결과.
- **`ready` (`SessionReady`)**:
  - STT 엔진이 세션을 성공적으로 초기화했을 때 전송할 수 있습니다.
  - `server_session_id` (string): STT 엔진이 내부적으로 관리하는 세션 ID.
- **`error` (`Status`)**:
  - 처리 중 에러 발생 시, gRPC 표준 `Status` 메시지를 통해 에러 코드와 메시지를 전달합니다.

**실제 데이터 예시 (STT 엔진의 응답):**
```protobuf
// 의사(pseudo) 코드 표현

// (중간 결과 응답)
StreamingRecognizeResponse {
  transcript: Transcript {
    text: "네 안녕",
    is_final: false
  }
}

// (최종 결과 응답)
StreamingRecognizeResponse {
  transcript: Transcript {
    text: "네 안녕하세요.",
    is_final: true
  }
}
```

### 4.5. 인증 및 TLS
- **인증**: `STT_GRPC_AUTH_TOKEN` 환경 변수가 설정된 경우, AudioHook 서버는 모든 요청의 메타데이터에 `authorization: Bearer {TOKEN}` 헤더를 포함하여 전송합니다.
- **TLS**: `STT_GRPC_TLS_ENABLED=true`로 설정하여 TLS 암호화 통신을 활성화할 수 있습니다. 관련 인증서 파일(`CA`, `CERT`, `KEY`) 경로를 환경 변수로 지정해야 합니다.

---

## 5. TCP 프로토콜 명세

로우-레벨(low-level) 프로토콜로, 특수한 환경이나 기존 시스템과의 연동을 위해 제공됩니다.

### 5.1. 연결 및 인증
- **Endpoint**: `STT_ENDPOINT`에 `host:port` 형식으로 지정합니다. (예: `stt.example.com:5000`)
- **TLS**: `STT_TCP_TLS_ENABLED=true`로 설정하여 TLS 암호화 소켓 연결을 사용할 수 있습니다.

### 5.2. 데이터 프레이밍 (Framing)
TCP는 스트림 기반 프로토콜이므로 메시지 경계를 구분하기 위한 프레이밍 규칙이 필수적입니다. `STT_TCP_FRAMING` 환경 변수로 방식을 선택합니다.

- **`raw` (기본값)**: 프레이밍 없음. 오디오 데이터가 연속적인 바이트 스트림으로 전송됩니다. STT 엔진이 스트림을 직접 처리해야 합니다.
  - **실제 데이터 예시**: `[Audio Chunk 1][Audio Chunk 2][Audio Chunk 3]...`

- **`len32`**: 각 오디오 데이터 청크 앞에 4-byte Big-Endian 형식의 길이 정보(헤더)를 붙여서 전송합니다.
  - **구조**: `[4-byte Length Header][Audio Data]`
  - **STT 엔진 구현**: 4바이트를 먼저 읽어 길이를 파악한 후, 해당 길이만큼의 오디오 데이터를 읽어야 합니다.
  - **실제 데이터 예시**: 640 바이트(`0x00000280`) 오디오 청크를 보내는 경우
    - `[0x00, 0x00, 0x02, 0x80][Audio Data (640 bytes)]`

- **`newline`**: 각 오디오 데이터 청크 뒤에 개행 문자(`\n`, `0x0A`)를 붙여서 전송합니다.
  - **실제 데이터 예시**: `[Audio Data (640 bytes)][0x0A]`

### 5.3. 초기/종료 시퀀스
- **초기 메시지**: `STT_TCP_INIT_HEX` 환경 변수에 정의된 16진수 문자열을 바이너리로 변환하여 연결 직후 전송합니다. STT 엔진이 요구하는 고정된 핸드셰이크 시퀀스가 있을 경우 사용합니다.
  - **설정 예시**: `STT_TCP_INIT_HEX="01020304"`
  - **실제 전송 데이터**: `[0x01, 0x02, 0x03, 0x04]`
- **종료 메시지**: `STT_TCP_BYE_HEX` 환경 변수에 정의된 16진수 문자열을 바이너리로 변환하여 연결 종료 직전에 전송합니다.
  - **설정 예시**: `STT_TCP_BYE_HEX="FFFF"`
  - **실제 전송 데이터**: `[0xFF, 0xFF]`

### 5.4. 데이터 흐름
1.  TCP 소켓 연결.
2.  (설정 시) `STT_TCP_INIT_HEX`에 정의된 초기 바이너리 시퀀스 전송.
3.  오디오 데이터를 `STT_TCP_FRAMING` 방식에 맞춰 프레이밍하여 지속적으로 전송.
4.  (설정 시) 연결 종료 전 `STT_TCP_BYE_HEX`에 정의된 종료 바이너리 시퀀스 전송.
5.  소켓 연결 종료.

**참고**: TCP 프로토콜은 단방향(AudioHook → STT) 데이터 전송을 기본으로 하며, STT 엔진으로부터의 피드백(전사 결과)을 받는 표준 방식은 정의되어 있지 않습니다.
