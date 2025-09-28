# UMC 기반 MRCP 브릿지 사용 가이드

이 브릿지는 UniMRCP의 CLI 클라이언트(umc)를 호출해 MRCP 인식을 수행합니다. 실시간 스트리밍이 아닌 배치 방식으로, AudioHook가 수집한 오디오를 WAV로 저장한 뒤 umc를 실행하고 결과를 파싱합니다.

제약사항
- 실시간 응답이 아님(세션 종료 시 결과 1회 보고)
- 정확한 RTSP/RTP 설정은 UniMRCP 서버와 client-profiles.xml(프로필)에서 관리

사전 준비
- UniMRCP 설치(Windows: C:\Program Files\UniMRCP, Linux: /usr/local)
- umc 실행 파일 경로 확인(Windows: C:\Program Files\UniMRCP\bin\umc.exe)
- client-profiles.xml에 asr-default 프로필 구성

환경 변수
- UNIMRCP_ROOT: UMC가 사용할 루트(여기서 conf/client-profiles.xml을 읽음)
- UMC_PROFILE: 사용할 클라이언트 프로필 이름(기본 asr-default)
- STT_UMC_EXE / UMC_EXE / UNIMRCP_UMC_EXE: umc 실행 파일 경로(미지정 시 기본 경로 추정)

프로젝트 설정
- .env
  - STT_PROTOCOL=mrcp
  - STT_ENDPOINT=rtsp://127.0.0.1:8060/unimrcp
  - STT_ENCODING=PCMU
  - STT_RATE=8000
  - STT_MRCP_BRIDGE=./audiohook/src/mrcp/bridge-umc.ts 또는 빌드 산출물 경로

동작 방식
1) 포워더가 오디오 프레임을 수집하여 raw(L16 또는 PCMU)로 버퍼링
2) 세션 종료(stop) 시 임시 WAV 생성
3) umc를 -r UNIMRCP_ROOT -p UMC_PROFILE -i <wav>로 실행
4) 표준 출력에서 텍스트를 추출해 result 이벤트 발생

문제 해결
- 결과가 나오지 않음: umc 콘솔 출력 확인, 프로필/서버 연결 점검
- 파일 권한 문제: temp 디렉터리 접근 권한, 실행 경로 확인
- 여전히 Mock 사용: .env의 STT_MRCP_BRIDGE가 올바른 경로인지 확인하고 앱 로그에서 Using custom MRCP bridge 메시지 확인
