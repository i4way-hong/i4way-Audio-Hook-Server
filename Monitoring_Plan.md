# 실시간 모니터링 페이지 구축 계획 (Monitoring_Plan.md)

## 1. 목표
AudioHook 서버의 처리 현황과 시스템 상태를 실시간으로 시각화하여, 운영자가 한눈에 서비스 상태를 파악하고 장애 발생 시 신속하게 원인을 진단할 수 있는 모니터링 대시보드를 구축한다.

## 2. 기술 스택 및 아키텍처

-   **Metrics Exporter**:
    -   **Application Metrics**: **Prometheus**. 현재 프로젝트에 `/metrics` 엔드포인트가 구현되어 있으므로, `prom-client`를 사용하여 수집할 지표를 추가 확장합니다.
    -   **Container Metrics**: **cAdvisor (Container Advisor)**. Google에서 개발한 오픈소스로, 실행 중인 컨테이너의 리소스 사용량(CPU, 메모리, 네트워크, 파일시스템 등)을 수집하여 Prometheus가 가져갈 수 있도록 노출합니다.
-   **Metrics Scraper & Storage**: **Prometheus Server**. AudioHook 서버의 `/metrics`와 cAdvisor의 `/metrics` 엔드포인트를 주기적으로 스크래핑하여 시계열 데이터(Time-Series Data)로 저장합니다.
-   **Visualization**: **Grafana**. Prometheus에 저장된 데이터를 쿼리하여 다양한 차트와 그래프로 시각화하는 대시보드를 구축합니다.

### 아키텍처 흐름도
```
+---------------------+      /metrics      +-------------------+      PromQL      +----------------+
| AudioHook App       | -----------------> |                   | <--------------- |                |
| (Node.js/Fastify)   |      (scrape)      |                   |      (query)     |                |
+---------------------+                    | Prometheus Server |                  | Grafana        |
                                           | (TSDB)            |                  | (Visualization)|
+---------------------+      /metrics      |                   |      PromQL      |                |
| cAdvisor            | -----------------> |                   | <--------------- |                |
| (Container Metrics) |      (scrape)      +-------------------+      (query)     +----------------+
+---------------------+                                                                   ^
                                                                                          |
                                                                                          |
                                                                                       (운영자)
```

### Docker Compose 통합
모니터링 스택(Prometheus, Grafana)과 cAdvisor를 `docker-compose.yml` 파일에 함께 정의하여 전체 서비스를 한 번에 관리할 수 있습니다.

**`docker-compose.monitoring.yml` (예시)**
```yaml
version: '3.8'

services:
  app:
    # ... 기존 AudioHook App 서비스 정의 ...
    image: audiohook-app
    ports:
      - "3000:3000"

  prometheus:
    image: prom/prometheus:v2.47.2
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:10.2.0
    container_name: grafana
    ports:
      - "4000:3000" # Host 4000 -> Container 3000
    depends_on:
      - prometheus

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.47.2
    container_name: cadvisor
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    depends_on:
      - app
```

## 3. 핵심 모니터링 지표 정의
대시보드에 표현할 핵심 지표들은 다음과 같이 분류하여 수집 및 시각화한다.

### 3.1. 컨테이너 리소스 현황 (Container Resources - from cAdvisor)
cAdvisor를 통해 수집되는 컨테이너별 시스템 리소스 지표.

| 지표명 (cAdvisor) | 타입 | 설명 | 시각화 방안 |
| :--- | :--- | :--- | :--- |
| `container_cpu_usage_seconds_total` | Counter | 컨테이너별 누적 CPU 사용 시간 (레이블: `name`, `image`) | **Time Series Graph** (Rate 적용, 컨테이너별 CPU 사용률) |
| `container_memory_usage_bytes` | Gauge | 컨테이너별 현재 메모리 사용량 (레이블: `name`, `image`) | **Time Series Graph** (컨테이너별 메모리 사용량) |
| `container_network_receive_bytes_total` | Counter | 컨테이너별 누적 네트워크 수신량 | **Time Series Graph** (Rate 적용, 초당 수신량) |
| `container_network_transmit_bytes_total` | Counter | 컨테이너별 누적 네트워크 송신량 | **Time Series Graph** (Rate 적용, 초당 송신량) |
| `container_fs_usage_bytes` | Gauge | 컨테이너별 파일시스템 사용량 | **Table** |

### 3.2. 서비스 전체 현황 (Global Status)
서비스의 전반적인 부하와 상태를 파악하기 위한 지표.

| 지표명 | 타입 | 설명 | 시각화 방안 |
| :--- | :--- | :--- | :--- |
| `audiohook_active_sessions` | Gauge | 현재 활성화된 총 WebSocket 세션 수 | **Single Stat**, **Time Series Graph** |
| `audiohook_http_requests_total` | Counter | HTTP 요청 수 (레이블: `method`, `path`, `status_code`) | **Bar Chart** (분당 요청 수), **Table** (상태 코드별) |
| `audiohook_http_request_duration_seconds` | Histogram | HTTP 요청 처리 시간 분포 | **Heatmap**, **95th/99th Percentile Graph** |
| `nodejs_heap_space_size_used_bytes` | Gauge | Node.js 힙 메모리 사용량 | **Time Series Graph** (메모리 누수 확인) |
| `nodejs_eventloop_lag_seconds` | Gauge | Node.js 이벤트 루프 지연 시간 | **Time Series Graph** (과부하 상태 확인) |

### 3.3. 세션 상세 현황 (Session Details)
개별 세션의 라이프사이클과 데이터 흐름을 추적하기 위한 지표.

| 지표명 | 타입 | 설명 | 시각화 방안 |
| :--- | :--- | :--- | :--- |
| `audiohook_session_duration_seconds` | Histogram | 세션 지속 시간 분포 | **Histogram Chart** |
| `audiohook_session_disconnects_total` | Counter | 세션 종료 횟수 (레이블: `reason`) | **Pie Chart** (종료 사유별 비율) |
| `audiohook_session_received_bytes_total` | Counter | 세션당 수신한 총 오디오 데이터양 | **Time Series Graph** (레이블: `session_id`) |
| `audiohook_session_events_total` | Counter | 전송된 이벤트 수 (레이블: `event_type`) | **Bar Chart** |

### 3.4. STT 포워더 상태 (STT Forwarder Status)
가장 중요한 외부 의존성인 STT(Speech-to-Text) 서비스 연동 상태를 모니터링하기 위한 지표.

| 지표명 | 타입 | 설명 | 시각화 방안 |
| :--- | :--- | :--- | :--- |
| `stt_forwarder_status` | Gauge | 포워더 연결 상태 (레이블: `protocol`, `endpoint`) (1: connected, 0: disconnected) | **Single Stat** (프로토콜별 색상 구분) |
| `stt_forwarder_latency_seconds` | Histogram | 오디오 수신 후 STT 서버로 전송까지 걸린 시간 | **Heatmap**, **95th/99th Percentile Graph** |
| `stt_forwarder_reconnects_total` | Counter | STT 서버 재연결 시도 횟수 (레이블: `protocol`) | **Time Series Graph** (재연결 급증 시 알림) |
| `stt_forwarder_errors_total` | Counter | STT 연동 중 발생한 에러 (레이블: `protocol`, `error_code`) | **Table**, **Alert** |
| `stt_forwarder_transcript_received_total` | Counter | STT로부터 수신한 전사 결과 수 (레이블: `is_final`) | **Time Series Graph** (final/partial 비교) |

### 3.5. 오디오 처리 (Audio Processing)
리샘플링 등 내부 오디오 처리 과정의 부하와 상태를 확인하기 위한 지표.

| 지표명 | 타입 | 설명 | 시각화 방안 |
| :--- | :--- | :--- | :--- |
| `audio_resampling_processed_total` | Counter | 리샘플링이 수행된 오디오 프레임 수 | **Time Series Graph** |
| `audio_resampling_duration_seconds` | Histogram | 리샘플링 처리 시간 | **Heatmap** |
| `audio_format_mix` | Counter | 수신된 오디오 포맷/레이트 분포 (레이블: `format`, `rate`) | **Pie Chart** |

## 4. Grafana 대시보드 구성(안)
위 지표들을 활용하여 다음과 같은 패널로 구성된 대시보드를 만든다.

-   **[Row 1: Global Overview]**
    -   (Single Stat) Active Sessions
    -   (Single Stat) HTTP 5xx Errors (Last 5m)
    -   (Time Series) HTTP Requests per Second
    -   (Time Series) 95th Percentile HTTP Latency
-   **[Row 2: System & Container Health]**
    -   (Time Series) Container CPU Usage (%) (by container name)
    -   (Time Series) Container Memory Usage (MB) (by container name)
    -   (Time Series) Node.js Heap Memory
    -   (Time Series) Event Loop Lag
-   **[Row 3: STT Forwarder Health]**
    -   (Single Stat) WebSocket Forwarder Status
    -   (Single Stat) gRPC Forwarder Status
    -   (Time Series) STT Forwarder Latency (p99)
    -   (Time Series) STT Reconnects
-   **[Row 4: Session & Data Details]**
    -   (Pie Chart) Session Disconnect Reasons
    -   (Time Series) Total Bytes Received
    -   (Histogram) Session Duration Distribution

## 5. 실행 계획
1.  **지표 노출 코드 추가**: `prom-client` 라이브러리를 `package.json`에 추가하고, `src/index.ts` 또는 별도의 `metrics.ts` 파일에서 위에서 정의한 커스텀 지표들을 등록하고 업데이트하는 로직을 구현한다.
2.  **모니터링 스택 구성**: `docker-compose.monitoring.yml` 파일을 작성하여 `prometheus`, `grafana`, `cadvisor` 서비스를 정의한다.
3.  **Prometheus 설정**: `prometheus.yml`에 `app`과 `cadvisor`의 `/metrics` 엔드포인트를 스크래핑하도록 `scrape_configs`를 추가한다.
4.  **Grafana 대시보드 생성**: Grafana에 접속하여 Prometheus를 데이터 소스로 추가하고, 위 '4. 대시보드 구성(안)'에 따라 패널들을 생성하고 PromQL 쿼리를 작성한다.
5.  **문서화**: 생성된 대시보드 사용법과 각 지표의 의미를 `README.md` 또는 별도 운영 문서에 기록한다.

