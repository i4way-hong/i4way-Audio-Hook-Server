-시작 path
````bash
cd /opt/audiohook/compose
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml up -d
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml ps
curl -i http://127.0.0.1:3000/health/check
````


- 컨테이너 생성 및 기동
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml up -d
````

- 컨테이너 종료 및 정리(컨테이너/네트워크 제거)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml down
````

- 컨테이너 시작
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start
````

- 특정 컨테이너만 시작
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start app
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start app2
````

- 실행만 중지(컨테이너 남김, 곧바로 재시작 가능)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml stop
````

- 특정 서비스만 중지/삭제(예: app2만)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml stop app2
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml rm -f app2
````

- 스케일을 줄여 1개만 유지
````bash
docker compose up -d --scale app=1
````

- 볼륨까지 함께 삭제하려면
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml down --volumes
````

상태 확인:
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml ps
````

// ...existing code...

- 로그 보기(전체 서비스)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f
````

-  특정 서비스(app/app2)만
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app2
````

- 최근 N줄만(스트리밍 없이)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs --tail=200 app
````

- 타임스탬프/기간 지정
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f --timestamps --since="10m" app
````

- 스케일링된 개별 컨테이너만(이름 확인 후)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml ps
docker logs -f compose-app-2
````

- 에러만 필터
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app | grep -i error
````