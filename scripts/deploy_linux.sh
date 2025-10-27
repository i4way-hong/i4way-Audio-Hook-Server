#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR=${TARGET_DIR:-/app/audiohook-server-1.0.2}
# NODE_MAJOR를 환경 변수로 재정의하면 특정 Node 버전을 강제하지 않고 사용할 수 있음 (예: NODE_MAJOR=20).
NODE_MAJOR=${NODE_MAJOR:-22}
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER_EXPECTED=${APP_USER_EXPECTED:-appadm}
SKIP_NODE_INSTALL=${SKIP_NODE_INSTALL:-0}
PACKAGE_MANAGER=""

log() {
  printf '\033[1;34m[audiohook]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[audiohook][WARN]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[audiohook][ERROR]\033[0m %s\n' "$*" >&2
  exit 1
}

ensure_sudo() {
  if [[ $EUID -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      fail "관리자 권한이 필요합니다. root 사용자로 실행하거나 sudo 패키지를 설치하세요."
    fi
  else
    SUDO=""
  fi
}

ensure_user() {
  local current
  current="$(id -un)"
  if [[ "${APP_USER_EXPECTED}" != "" && "${current}" != "${APP_USER_EXPECTED}" ]]; then
    warn "현재 사용자(${current})가 예상된 사용자(${APP_USER_EXPECTED})와 다릅니다. 필요 시 'su - ${APP_USER_EXPECTED}'로 전환하세요."
  fi
}

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    PACKAGE_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PACKAGE_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PACKAGE_MANAGER="yum"
  elif command -v zypper >/dev/null 2>&1; then
    PACKAGE_MANAGER="zypper"
  else
    PACKAGE_MANAGER=""
  fi
}

ensure_packages() {
  case "${PACKAGE_MANAGER}" in
    apt)
      log "필수 패키지를 설치합니다 (apt)."
      ${SUDO} apt-get update -y
      ${SUDO} apt-get install -y ca-certificates curl build-essential python3 make gcc g++ git rsync
      ;;
    dnf|yum)
      log "필수 패키지를 설치합니다 (${PACKAGE_MANAGER})."
      ${SUDO} ${PACKAGE_MANAGER} install -y ca-certificates curl gcc-c++ make python3 git rsync
      ;;
    zypper)
      log "필수 패키지를 설치합니다 (zypper)."
      ${SUDO} zypper --non-interactive refresh
      ${SUDO} zypper --non-interactive install ca-certificates curl gcc-c++ make python3 git rsync
      ;;
    *)
      warn "지원되는 패키지 관리자를 찾을 수 없습니다. 필수 패키지는 수동으로 설치해야 합니다. (curl, git, gcc/g++, make, python3, rsync)"
      ;;
  esac
}

install_node() {
  if [[ "${SKIP_NODE_INSTALL}" == "1" ]]; then
    log "SKIP_NODE_INSTALL=1로 설정되어 있어 Node.js 설치를 건너뜁니다."
    return
  fi

  local need_install="1"
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${current_major}" == "${NODE_MAJOR}" ]]; then
      need_install="0"
      log "Node.js $(node -v)를 사용합니다."
    else
      warn "Node.js $(node -v)가 감지되었습니다. ${NODE_MAJOR} 버전으로 교체합니다."
    fi
  else
    log "Node.js가 설치되어 있지 않습니다. ${NODE_MAJOR} 버전을 설치합니다."
  fi

  if [[ "${need_install}" == "1" ]]; then
    case "${PACKAGE_MANAGER}" in
      apt)
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | ${SUDO} bash -
        ${SUDO} apt-get install -y nodejs
        ;;
      dnf|yum)
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | ${SUDO} bash -
        ${SUDO} ${PACKAGE_MANAGER} install -y nodejs
        ;;
      zypper)
        warn "자동 Node.js 설치를 위한 공식 스크립트가 없습니다. nvm 또는 tar.xz 바이너리를 사용하여 Node.js ${NODE_MAJOR}를 설치하세요. 설치를 완료한 후 SKIP_NODE_INSTALL=1로 스크립트를 다시 실행할 수 있습니다."
        fail "Node.js ${NODE_MAJOR} 수동 설치 필요"
        ;;
      *)
        fail "자동으로 Node.js를 설치할 수 없습니다. Node.js ${NODE_MAJOR} 버전을 수동으로 설치하거나 SKIP_NODE_INSTALL=1로 설정 후 재실행하세요."
        ;;
    esac
    log "Node.js $(node -v) 설치 완료."
  fi
}

prepare_target_dir() {
  if [[ ! -d "${TARGET_DIR}" ]]; then
    log "${TARGET_DIR} 디렉터리를 생성합니다."
    if [[ -n "${SUDO}" ]]; then
      ${SUDO} mkdir -p "${TARGET_DIR}"
    else
      mkdir -p "${TARGET_DIR}"
    fi
  fi

  if [[ -n "${SUDO}" ]]; then
    ${SUDO} chown "$(id -un):$(id -gn)" "${TARGET_DIR}"
  fi
}

sync_sources() {
  log "소스를 ${TARGET_DIR}로 동기화합니다."
  local excludes=("--exclude" ".git" "--exclude" "node_modules" "--exclude" "dist" "--exclude" "logs" "--exclude" "recordings")
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${excludes[@]}" "${PROJECT_ROOT}/" "${TARGET_DIR}/"
  else
    warn "rsync이 없어 tar를 사용합니다."
    (cd "${PROJECT_ROOT}" && tar --exclude=".git" --exclude="node_modules" --exclude="dist" --exclude="logs" --exclude="recordings" -cf - .) | (cd "${TARGET_DIR}" && tar -xf -)
  fi
}

install_dependencies() {
  log "npm 의존성을 설치합니다."
  (cd "${TARGET_DIR}" && npm ci)
}

build_project() {
  log "TypeScript 빌드를 수행합니다."
  (cd "${TARGET_DIR}" && npm run build)
}

prepare_env_template() {
  if [[ -f "${TARGET_DIR}/.env" ]]; then
    log ".env 파일이 이미 존재하므로 유지합니다."
  elif [[ -f "${TARGET_DIR}/.env.example" ]]; then
    log ".env.example을 기반으로 .env 파일을 생성합니다."
    cp "${TARGET_DIR}/.env.example" "${TARGET_DIR}/.env"
  else
    warn ".env.example이 없어 환경 변수 파일을 자동 생성하지 못했습니다."
  fi
}

create_run_script() {
  local run_file="${TARGET_DIR}/start-audiohook.sh"
  log "실행 스크립트 ${run_file}를 생성합니다."
  cat > "${run_file}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi
export NODE_ENV=${NODE_ENV:-production}
cd "${SCRIPT_DIR}"
exec node dist/src/index.js "$@"
EOF
  chmod +x "${run_file}"
}

main() {
  ensure_sudo
  ensure_user
  detect_package_manager
  ensure_packages
  install_node
  prepare_target_dir
  sync_sources
  install_dependencies
  build_project
  prepare_env_template
  create_run_script
  log "배포가 완료되었습니다. start-audiohook.sh 스크립트로 서버를 실행하세요."
}

main "$@"
