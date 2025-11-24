#!/usr/bin/env bash
#
# NetSwift ULTIMATE One-Liner Deployment
# Version: 6.1.0 - Playwright Edition
# 
# Everything is downloaded from GitHub - user just runs ONE command!
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/netswift/main/deploy.sh | sudo bash -s -- \
#     --github-repo "YOUR_ORG/netswift" \
#     --admin-password "SecurePass123!"
#
# What it does:
#   1. Downloads netswift.json from your GitHub repo
#   2. Downloads automation script from your GitHub repo
#   3. Installs all dependencies (Docker, Node.js)
#   4. Deploys containers (Appsmith + Backend)
#   5. Runs Playwright automation (admin, import, datasource, deploy)
#   6. DONE! Zero manual steps.
#
# NEW in 6.1.0:
#   • Playwright automation for superior reliability
#   • Auto-waiting eliminates timing issues
#   • Trace viewer for easy debugging
#

set -euo pipefail

#═══════════════════════════════════════════════════════════════════════════
# CONFIGURATION
#═══════════════════════════════════════════════════════════════════════════

readonly SCRIPT_VERSION="6.1.0"
readonly INSTALL_DIR="/opt/netswift"
readonly LOG_FILE="/var/log/netswift-install.log"

# GitHub configuration - HARDCODED for simplicity
GITHUB_REPO="${NETSWIFT_GITHUB_REPO:-melsayeh/netswift2-installer}"
GITHUB_BRANCH="${NETSWIFT_GITHUB_BRANCH:-main}"
GITHUB_TOKEN="${NETSWIFT_GITHUB_TOKEN:-}"  # Optional, for private repos

# Application files in GitHub repo
JSON_FILE_PATH="${NETSWIFT_JSON_PATH:-netswift.json}"
AUTOMATION_SCRIPT_PATH="${NETSWIFT_AUTOMATION_PATH:-automation/appsmith-automation-json.js}"

# Docker images
DOCKER_IMAGE="${NETSWIFT_BACKEND_IMAGE:-melsayeh/netswift-backend}"
DOCKER_TAG="${NETSWIFT_BACKEND_TAG:-2.0.0}"
APPSMITH_IMAGE="appsmith/appsmith-ce:latest"

# Admin configuration - HARDCODED for simplicity (internal use only)
APPSMITH_ADMIN_EMAIL="${NETSWIFT_ADMIN_EMAIL:-admin@netswift.com}"
APPSMITH_ADMIN_PASSWORD="${NETSWIFT_ADMIN_PASSWORD:-netswiftadmin}"
APPSMITH_ADMIN_NAME="${NETSWIFT_ADMIN_NAME:-NetSwift Admin}"

# Datasource configuration
DATASOURCE_URL="${NETSWIFT_DATASOURCE_URL:-http://172.17.0.1:8000}"

# Automation configuration
HEADLESS_MODE="${NETSWIFT_HEADLESS:-true}"

#═══════════════════════════════════════════════════════════════════════════
# COLORS
#═══════════════════════════════════════════════════════════════════════════

if [[ -t 1 ]]; then
    readonly RED='\033[0;31m'
    readonly GREEN='\033[0;32m'
    readonly YELLOW='\033[1;33m'
    readonly BLUE='\033[0;34m'
    readonly CYAN='\033[0;36m'
    readonly BOLD='\033[1m'
    readonly NC='\033[0m'
else
    readonly RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' NC=''
fi

#═══════════════════════════════════════════════════════════════════════════
# LOGGING
#═══════════════════════════════════════════════════════════════════════════

log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${message}"
    echo "[${timestamp}] [${level}] ${message}" | sed 's/\x1b\[[0-9;]*m//g' >> "${LOG_FILE}"
}

log_info() { log "INFO" "${BLUE}ℹ${NC} $*"; }
log_success() { log "SUCCESS" "${GREEN}✓${NC} $*"; }
log_warning() { log "WARNING" "${YELLOW}⚠${NC} $*"; }
log_error() { log "ERROR" "${RED}✗${NC} $*"; }
log_step() { log "STEP" "\n${CYAN}${BOLD}[$1]${NC} $2"; }

#═══════════════════════════════════════════════════════════════════════════
# UTILITIES
#═══════════════════════════════════════════════════════════════════════════

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

get_server_ip() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ -z "${ip}" ]] && ip=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
    [[ -z "${ip}" ]] && ip="localhost"
    echo "${ip}"
}

get_host_timezone() {
    local tz
    
    # Try to get timezone from timedatectl (systemd)
    if command_exists timedatectl; then
        tz=$(timedatectl | grep "Time zone" | awk '{print $3}')
    fi
    
    # Fallback: check /etc/timezone
    if [[ -z "${tz}" ]] && [[ -f /etc/timezone ]]; then
        tz=$(cat /etc/timezone)
    fi
    
    # Fallback: check symlink /etc/localtime
    if [[ -z "${tz}" ]] && [[ -L /etc/localtime ]]; then
        tz=$(readlink /etc/localtime | sed 's|/usr/share/zoneinfo/||')
    fi
    
    # Final fallback: UTC
    [[ -z "${tz}" ]] && tz="UTC"
    
    echo "${tz}"
}

docker_compose() {
    if docker compose version &>/dev/null; then
        docker compose "$@"
    else
        docker-compose "$@"
    fi
}

#═══════════════════════════════════════════════════════════════════════════
# ARGUMENT PARSING
#═══════════════════════════════════════════════════════════════════════════

show_usage() {
    cat << 'EOF'
NetSwift 6.0 - Ultimate One-Liner Deployment

Usage:
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash

  That's it! No parameters needed!

Default Configuration:
  GitHub Repo:  melsayeh/netswift2-installer
  Admin Email:  admin@netswift.com
  Admin Pass:   netswiftadmin
  Backend URL:  http://172.17.0.1:8000

Optional Overrides:
  --github-repo REPO         GitHub repository (default: melsayeh/netswift2-installer)
  --github-branch BRANCH     GitHub branch (default: main)
  --github-token TOKEN       GitHub token for private repos
  --json-path PATH           Path to JSON in repo (default: netswift.json)
  --automation-path PATH     Path to automation script (default: automation/appsmith-automation-json.js)
  --admin-email EMAIL        Admin email (default: admin@netswift.com)
  --admin-password PASS      Admin password (default: netswiftadmin)
  --admin-name NAME          Admin name (default: NetSwift Admin)
  --datasource-url URL       Backend URL (default: http://172.17.0.1:8000)
  --backend-image IMAGE      Backend Docker image (default: melsayeh/netswift-backend)
  --backend-tag TAG          Backend Docker tag (default: 2.0.0)
  --headless BOOL            Run browser headless (default: true)
  --help                     Show this help

Examples:

  # Default (no parameters - recommended):
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash

  # Custom admin password:
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash -s -- \
    --admin-password "YourCustomPassword123!"

  # Custom admin email:
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash -s -- \
    --admin-email "admin@company.com"

  # Watch deployment (non-headless):
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash -s -- \
    --headless false

  # Use different repo (if you forked):
  curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/netswift/main/deploy.sh | sudo bash -s -- \
    --github-repo "YOUR_ORG/netswift"

Environment Variables (alternative to command line):
  NETSWIFT_GITHUB_REPO       (default: melsayeh/netswift2-installer)
  NETSWIFT_GITHUB_BRANCH     (default: main)
  NETSWIFT_GITHUB_TOKEN
  NETSWIFT_JSON_PATH         (default: netswift.json)
  NETSWIFT_AUTOMATION_PATH   (default: automation/appsmith-automation-json.js)
  NETSWIFT_ADMIN_EMAIL       (default: admin@netswift.com)
  NETSWIFT_ADMIN_PASSWORD    (default: netswiftadmin)
  NETSWIFT_ADMIN_NAME        (default: NetSwift Admin)
  NETSWIFT_DATASOURCE_URL    (default: http://172.17.0.1:8000)
  NETSWIFT_BACKEND_IMAGE     (default: melsayeh/netswift-backend)
  NETSWIFT_BACKEND_TAG       (default: 2.0.0)
  NETSWIFT_HEADLESS          (default: true)

After Deployment:
  Access:  http://YOUR_SERVER_IP
  Email:   admin@netswift.com
  Password: netswiftadmin

Note: This is configured for internal organizational use. The default password
      is hardcoded for simplicity. Change it after first login if needed.

EOF
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --github-repo)
                GITHUB_REPO="$2"
                shift 2
                ;;
            --github-branch)
                GITHUB_BRANCH="$2"
                shift 2
                ;;
            --github-token)
                GITHUB_TOKEN="$2"
                shift 2
                ;;
            --json-path)
                JSON_FILE_PATH="$2"
                shift 2
                ;;
            --automation-path)
                AUTOMATION_SCRIPT_PATH="$2"
                shift 2
                ;;
            --admin-email)
                APPSMITH_ADMIN_EMAIL="$2"
                shift 2
                ;;
            --admin-password)
                APPSMITH_ADMIN_PASSWORD="$2"
                shift 2
                ;;
            --admin-name)
                APPSMITH_ADMIN_NAME="$2"
                shift 2
                ;;
            --datasource-url)
                DATASOURCE_URL="$2"
                shift 2
                ;;
            --backend-image)
                DOCKER_IMAGE="$2"
                shift 2
                ;;
            --backend-tag)
                DOCKER_TAG="$2"
                shift 2
                ;;
            --headless)
                HEADLESS_MODE="$2"
                shift 2
                ;;
            --help)
                show_usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
}

validate_config() {
    log_info "Validating configuration..."
    
    # GitHub repo is optional (defaults to melsayeh/netswift2-installer)
    if [[ -n "${GITHUB_REPO}" ]] && [[ ! "${GITHUB_REPO}" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid GitHub repo format. Expected: owner/repo"
        exit 1
    fi
    
    # Admin password now has default value (netswiftadmin)
    if [[ ${#APPSMITH_ADMIN_PASSWORD} -lt 8 ]]; then
        log_error "Admin password must be at least 8 characters"
        exit 1
    fi
    
    log_success "Configuration validated"
}

#═══════════════════════════════════════════════════════════════════════════
# GITHUB DOWNLOAD FUNCTIONS
#═══════════════════════════════════════════════════════════════════════════

download_from_github() {
    local file_path="$1"
    local dest_path="$2"
    local url
    
    # Build GitHub raw content URL
    if [[ -n "${GITHUB_TOKEN}" ]]; then
        # Private repo with token
        url="https://${GITHUB_TOKEN}@raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${file_path}"
    else
        # Public repo
        url="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${file_path}"
    fi
    
    log_info "Downloading from GitHub: ${file_path}"
    
    if curl -fsSL -o "${dest_path}" "${url}"; then
        log_success "Downloaded: ${file_path}"
        return 0
    else
        log_error "Failed to download: ${file_path}"
        log_error "URL: ${url}"
        return 1
    fi
}

download_application_files() {
    log_info "Downloading application files from GitHub..."
    
    # Download JSON file
    if ! download_from_github "${JSON_FILE_PATH}" "${INSTALL_DIR}/netswift.json"; then
        log_error "Could not download JSON file"
        log_info "Make sure ${JSON_FILE_PATH} exists in your GitHub repo"
        exit 1
    fi
    
    # Download automation script
    if ! download_from_github "${AUTOMATION_SCRIPT_PATH}" "${INSTALL_DIR}/automation/automate.js"; then
        log_error "Could not download automation script"
        log_info "Make sure ${AUTOMATION_SCRIPT_PATH} exists in your GitHub repo"
        exit 1
    fi
    
    log_success "All application files downloaded from GitHub"
}

#═══════════════════════════════════════════════════════════════════════════
# INSTALLATION
#═══════════════════════════════════════════════════════════════════════════

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root or with sudo"
        exit 1
    fi
    log_success "Running as root"
}

install_dependencies() {
    log_info "Installing system dependencies..."
    
    if command_exists apt-get; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq curl wget git jq ca-certificates gnupg lsb-release \
            2>&1 | tee -a "${LOG_FILE}"
    elif command_exists yum; then
        yum install -y -q curl wget git jq ca-certificates \
            2>&1 | tee -a "${LOG_FILE}"
    else
        log_error "Unsupported package manager"
        exit 1
    fi
    
    log_success "Dependencies installed"
}

install_nodejs() {
    if command_exists node && [[ $(node --version | cut -d. -f1 | sed 's/v//') -ge 18 ]]; then
        log_success "Node.js already installed: $(node --version)"
        return 0
    fi
    
    log_info "Installing Node.js 20.x..."
    
    if command_exists apt-get; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tee -a "${LOG_FILE}"
        apt-get install -y nodejs 2>&1 | tee -a "${LOG_FILE}"
    elif command_exists yum; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>&1 | tee -a "${LOG_FILE}"
        yum install -y nodejs 2>&1 | tee -a "${LOG_FILE}"
    fi
    
    log_success "Node.js installed: $(node --version)"
}

install_docker() {
    if command_exists docker; then
        log_success "Docker already installed: $(docker --version)"
        return 0
    fi
    
    log_info "Installing Docker..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh 2>&1 | tee -a "${LOG_FILE}"
    rm /tmp/get-docker.sh
    
    systemctl enable docker
    systemctl start docker
    
    log_success "Docker installed: $(docker --version)"
}

setup_installation_directory() {
    log_info "Setting up installation directory..."
    mkdir -p "${INSTALL_DIR}"/{data,logs,automation}
    chmod 755 "${INSTALL_DIR}"
    log_success "Installation directory created: ${INSTALL_DIR}"
}

create_docker_compose() {
    log_info "Creating Docker Compose configuration..."
    
    # Detect host timezone
    local host_timezone
    host_timezone=$(get_host_timezone)
    log_info "Detected host timezone: ${host_timezone}"
    
    cat > "${INSTALL_DIR}/docker-compose.yml" << COMPOSE_EOF
services:
  netswift-backend:
    image: ${DOCKER_IMAGE}:${DOCKER_TAG}
    container_name: netswift-backend
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - PYTHONUNBUFFERED=1
      - TZ=${host_timezone}
    volumes:
      - ./data/backend:/app/data
      - ./logs/backend:/app/logs
    networks:
      - netswift-network
    healthcheck:
      test: ["CMD", "python", "-c", "import httpx; httpx.get('http://localhost:8000/health')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  appsmith:
    image: ${APPSMITH_IMAGE}
    container_name: netswift-appsmith
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - TZ=${host_timezone}
      - APPSMITH_DISABLE_TELEMETRY=true
      - APPSMITH_SIGNUP_DISABLED=false
    volumes:
      - ./data/appsmith:/appsmith-stacks
    networks:
      - netswift-network
    depends_on:
      netswift-backend:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 90s

networks:
  netswift-network:
    driver: bridge
COMPOSE_EOF
    
    log_success "Docker Compose configuration created with timezone: ${host_timezone}"
}

deploy_containers() {
    log_info "Deploying containers..."
    cd "${INSTALL_DIR}"
    
    echo ""
    log_info "Pulling Docker images..."
    docker_compose pull
    
    echo ""
    log_info "Starting containers..."
    docker_compose up -d
    
    echo ""
    log_success "Containers deployed"
}

wait_for_services() {
    log_info "Waiting for services to become healthy..."
    
    local max_wait=300
    local wait_time=0
    local sleep_interval=10
    
    while [[ ${wait_time} -lt ${max_wait} ]]; do
        if curl -f -s http://localhost:8000/health >/dev/null 2>&1 && \
           curl -f -s http://localhost/api/v1/health >/dev/null 2>&1; then
            log_success "All services are healthy"
            return 0
        fi
        
        log_info "Waiting for services... (${wait_time}s/${max_wait}s)"
        sleep ${sleep_interval}
        wait_time=$((wait_time + sleep_interval))
    done
    
    log_error "Services failed to become healthy within ${max_wait} seconds"
    return 1
}

setup_automation() {
    log_info "Setting up Playwright automation..."
    
    # Install npm dependencies
    log_info "Installing Playwright npm package (this may take a minute)..."
    cd "${INSTALL_DIR}/automation"
    npm install --silent 2>&1 | tee -a "${LOG_FILE}"
    
    # Install Chromium browser
    log_info "Installing Chromium browser for Playwright..."
    
    # Detect OS for dependency installation
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID}"
    fi
    
    # For RHEL-based systems (Rocky, CentOS, AlmaLinux, RHEL), skip system deps
    # They're not strictly needed for headless browser operation
    if [[ "${OS_ID}" =~ ^(rocky|rhel|centos|almalinux)$ ]]; then
        log_info "Detected ${OS_ID}, installing Chromium without system dependencies..."
        npx playwright install chromium 2>&1 | tee -a "${LOG_FILE}"
    else
        # For Ubuntu/Debian, use --with-deps
        log_info "Installing Chromium with system dependencies..."
        npx playwright install --with-deps chromium 2>&1 | tee -a "${LOG_FILE}"
    fi
    
    log_success "Playwright automation setup complete"
}

run_automation() {
    log_info "Running Playwright automation..."
    log_info "This will take 2-3 minutes..."
    
    local server_ip
    server_ip=$(get_server_ip)
    
    # Set environment variables
    export APPSMITH_URL="http://${server_ip}"
    export ADMIN_EMAIL="${APPSMITH_ADMIN_EMAIL}"
    export ADMIN_PASSWORD="${APPSMITH_ADMIN_PASSWORD}"
    export ADMIN_NAME="${APPSMITH_ADMIN_NAME}"
    export APP_JSON_PATH="${INSTALL_DIR}/netswift.json"
    export DATASOURCE_URL="${DATASOURCE_URL}"
    export HEADLESS="${HEADLESS_MODE}"
    export TIMEOUT="120000"
    export RECORD_TRACE="true"  # Enable trace recording for debugging
    
    cd "${INSTALL_DIR}/automation"
    
    if node automate.js 2>&1 | tee -a "${LOG_FILE}"; then
        log_success "Automation completed successfully!"
        return 0
    else
        log_error "Automation failed - check logs at ${LOG_FILE}"
        
        # Inform user about trace file for debugging
        if [[ -f "/tmp/appsmith-automation-trace.zip" ]]; then
            log_info "📊 Trace file available for debugging!"
            log_info "View with: cd ${INSTALL_DIR}/automation && npx playwright show-trace /tmp/appsmith-automation-trace.zip"
        fi
        
        log_warning "You can retry manually: cd ${INSTALL_DIR}/automation && npm start"
        return 1
    fi
}

create_management_scripts() {
    log_info "Creating management scripts..."
    
    cat > "${INSTALL_DIR}/status.sh" << 'SCRIPT'
#!/bin/bash
cd /opt/netswift || exit 1
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║                    NetSwift Status                                ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo
if docker compose version &>/dev/null; then
    docker compose ps
else
    docker-compose ps
fi
echo
echo "=== Health Checks ==="
echo -n "Backend:  "
curl -f -s http://localhost:8000/health >/dev/null 2>&1 && echo "✓ Healthy" || echo "✗ Unhealthy"
echo -n "Appsmith: "
curl -f -s http://localhost/api/v1/health >/dev/null 2>&1 && echo "✓ Healthy" || echo "✗ Unhealthy"
SCRIPT
    
    cat > "${INSTALL_DIR}/logs.sh" << 'SCRIPT'
#!/bin/bash
cd /opt/netswift || exit 1
if docker compose version &>/dev/null; then
    docker compose logs -f ${1:-}
else
    docker-compose logs -f ${1:-}
fi
SCRIPT
    
    cat > "${INSTALL_DIR}/restart.sh" << 'SCRIPT'
#!/bin/bash
cd /opt/netswift || exit 1
if docker compose version &>/dev/null; then
    docker compose restart
else
    docker-compose restart
fi
echo "✓ Services restarted"
SCRIPT
    
    cat > "${INSTALL_DIR}/update.sh" << 'SCRIPT'
#!/bin/bash
cd /opt/netswift || exit 1
echo "Pulling latest images..."
if docker compose version &>/dev/null; then
    docker compose pull && docker compose up -d
else
    docker-compose pull && docker-compose up -d
fi
echo "✓ Update complete"
SCRIPT
    
    cat > "${INSTALL_DIR}/redeploy-app.sh" << 'SCRIPT'
#!/bin/bash
# Re-run automation (useful if you updated netswift.json in GitHub)
cd /opt/netswift/automation || exit 1
export APPSMITH_URL="http://localhost"
export APP_JSON_PATH="/opt/netswift/netswift.json"
npm start
SCRIPT
    
    cat > "${INSTALL_DIR}/view-trace.sh" << 'SCRIPT'
#!/bin/bash
# View Playwright trace for debugging automation issues
cd /opt/netswift/automation || exit 1
TRACE_FILE="/tmp/appsmith-automation-trace.zip"

if [[ -f "${TRACE_FILE}" ]]; then
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║                    Opening Playwright Trace Viewer                ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo
    echo "This shows a detailed timeline of the automation with:"
    echo "  • Screenshots at every step"
    echo "  • DOM snapshots you can inspect"
    echo "  • Network requests and responses"
    echo "  • Console logs"
    echo "  • Timing information"
    echo
    npx playwright show-trace "${TRACE_FILE}"
else
    echo "No trace file found at ${TRACE_FILE}"
    echo "Trace files are created when automation fails"
    echo "or when ALWAYS_SAVE_TRACE=true is set"
fi
SCRIPT
    
    chmod +x "${INSTALL_DIR}"/*.sh
    log_success "Management scripts created"
}

#═══════════════════════════════════════════════════════════════════════════
# UPDATE FUNCTION
#═══════════════════════════════════════════════════════════════════════════

update_netswift() {
    log_step "UPDATE" "Updating NetSwift..."
    
    if [[ ! -d "${INSTALL_DIR}" ]]; then
        log_error "NetSwift is not installed. Please install first."
        exit 1
    fi
    
    cd "${INSTALL_DIR}"
    
    log_info "Pulling latest application from GitHub..."
    download_application_files
    
    log_info "Pulling latest Docker images..."
    echo ""
    docker_compose pull
    
    log_info "Restarting containers..."
    echo ""
    docker_compose up -d
    
    log_info "Waiting for services..."
    wait_for_services
    
    log_info "Running automation to redeploy application..."
    run_automation
    
    log_success "Update complete!"
    
    local server_ip
    server_ip=$(get_server_ip)
    
    echo ""
    echo -e "${GREEN}${BOLD}✅ NetSwift Updated Successfully!${NC}"
    echo ""
    echo -e "Access: ${BLUE}http://${server_ip}${NC}"
    echo -e "Email:  ${YELLOW}${APPSMITH_ADMIN_EMAIL}${NC}"
    echo -e "Pass:   ${YELLOW}${APPSMITH_ADMIN_PASSWORD}${NC}"
    echo ""
}

#═══════════════════════════════════════════════════════════════════════════
# UNINSTALL FUNCTION
#═══════════════════════════════════════════════════════════════════════════

uninstall_netswift() {
    log_step "UNINSTALL" "Uninstalling NetSwift..."
    
    if [[ ! -d "${INSTALL_DIR}" ]]; then
        log_warning "NetSwift is not installed"
        return 0
    fi
    
    echo ""
    echo -e "${RED}${BOLD}⚠️  WARNING ⚠️${NC}"
    echo -e "${RED}This will completely remove NetSwift including:${NC}"
    echo -e "  • All Docker containers"
    echo -e "  • All data and databases"
    echo -e "  • All configuration files"
    echo -e "  • Installation directory (${INSTALL_DIR})"
    echo ""
    read -p "Are you sure you want to uninstall? (yes/no): " confirm
    
    if [[ "${confirm}" != "yes" ]]; then
        log_info "Uninstall cancelled"
        return 0
    fi
    
    log_info "Stopping and removing containers..."
    cd "${INSTALL_DIR}"
    docker_compose down -v 2>/dev/null || true
    
    log_info "Removing Docker images..."
    docker rmi "${DOCKER_IMAGE}:${DOCKER_TAG}" 2>/dev/null || true
    docker rmi "${APPSMITH_IMAGE}" 2>/dev/null || true
    
    log_info "Removing installation directory..."
    cd /
    rm -rf "${INSTALL_DIR}"
    
    log_info "Removing log file..."
    rm -f "${LOG_FILE}"
    
    log_success "NetSwift uninstalled successfully!"
    echo ""
}

save_deployment_info() {
    log_info "Saving deployment information..."
    
    local server_ip
    server_ip=$(get_server_ip)
    
    cat > "${INSTALL_DIR}/deployment-info.txt" << EOF
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                     NetSwift Deployment Information                       ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝

Deployment Date: $(date '+%Y-%m-%d %H:%M:%S')
Server IP: ${server_ip}
Script Version: ${SCRIPT_VERSION}

GitHub Configuration:
  Repository: ${GITHUB_REPO}
  Branch: ${GITHUB_BRANCH}
  JSON File: ${JSON_FILE_PATH}
  Automation Script: ${AUTOMATION_SCRIPT_PATH}

Access Information:
  Appsmith URL: http://${server_ip}
  Backend API: http://${server_ip}:8000
  
Admin Credentials:
  Email: ${APPSMITH_ADMIN_EMAIL}
  Password: ${APPSMITH_ADMIN_PASSWORD}
  Name: ${APPSMITH_ADMIN_NAME}

Datasource:
  URL: ${DATASOURCE_URL}

Docker Images:
  Backend: ${DOCKER_IMAGE}:${DOCKER_TAG}
  Appsmith: ${APPSMITH_IMAGE}

Management Commands:
  Status: ${INSTALL_DIR}/status.sh
  Logs: ${INSTALL_DIR}/logs.sh [service]
  Restart: ${INSTALL_DIR}/restart.sh
  Update: ${INSTALL_DIR}/update.sh
  Redeploy App: ${INSTALL_DIR}/redeploy-app.sh

Logs:
  Installation: ${LOG_FILE}
  Container Logs: ${INSTALL_DIR}/logs.sh

To update application:
  1. Update netswift.json in GitHub
  2. Run: ${INSTALL_DIR}/redeploy-app.sh

EOF
    
    chmod 600 "${INSTALL_DIR}/deployment-info.txt"
    log_success "Deployment info saved to ${INSTALL_DIR}/deployment-info.txt"
}

#═══════════════════════════════════════════════════════════════════════════
# INSTALLATION FUNCTION
#═══════════════════════════════════════════════════════════════════════════

install_netswift() {
    log_step "1/12" "Checking prerequisites"
    check_root
    
    log_step "2/12" "Installing system dependencies"
    install_dependencies
    
    log_step "3/12" "Installing Node.js"
    install_nodejs
    
    log_step "4/12" "Installing Docker"
    install_docker
    
    log_step "5/12" "Setting up installation directory"
    setup_installation_directory
    
    log_step "6/12" "Downloading application files from GitHub"
    download_application_files
    
    log_step "7/12" "Creating Docker configuration"
    create_docker_compose
    
    log_step "8/12" "Deploying containers"
    deploy_containers
    
    log_step "9/12" "Waiting for services to be healthy"
    wait_for_services
    
    log_step "10/12" "Setting up Playwright automation"
    setup_automation
    
    log_step "11/12" "Running automation (2-3 minutes)"
    run_automation
    
    log_step "12/12" "Finalizing installation"
    create_management_scripts
    save_deployment_info
    
    local server_ip
    server_ip=$(get_server_ip)
    
    # Read the NetSwift URL if automation saved it
    local netswift_url=""
    if [[ -f "${INSTALL_DIR}/netswift-url.txt" ]]; then
        netswift_url=$(cat "${INSTALL_DIR}/netswift-url.txt")
    fi
    
    echo
    echo -e "${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║                                                                           ║${NC}"
    echo -e "${GREEN}${BOLD}║              🎉 INSTALLATION COMPLETED SUCCESSFULLY! 🎉                   ║${NC}"
    echo -e "${GREEN}${BOLD}║                                                                           ║${NC}"
    echo -e "${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo
    echo -e "${CYAN}${BOLD}🌐 Access Your Application:${NC}"
    if [[ -n "${netswift_url}" ]]; then
        echo -e "  URL:      ${BLUE}${netswift_url}${NC}"
    else
        echo -e "  URL:      ${BLUE}http://${server_ip}${NC}"
    fi
    echo -e "  Email:    ${YELLOW}${APPSMITH_ADMIN_EMAIL}${NC}"
    echo -e "  Password: ${YELLOW}${APPSMITH_ADMIN_PASSWORD}${NC}"
    echo
    echo -e "${CYAN}${BOLD}🔧 Management Commands:${NC}"
    echo -e "  Status:       ${INSTALL_DIR}/status.sh"
    echo -e "  Logs:         ${INSTALL_DIR}/logs.sh [service]"
    echo -e "  Restart:      ${INSTALL_DIR}/restart.sh"
    echo -e "  Update:       ${INSTALL_DIR}/update.sh"
    echo -e "  Redeploy App: ${INSTALL_DIR}/redeploy-app.sh"
    echo -e "  View Trace:   ${INSTALL_DIR}/view-trace.sh  ${GREEN}← Debug automation issues${NC}"
    echo
    echo -e "${CYAN}${BOLD}📝 Deployment Info:${NC}"
    echo -e "  ${INSTALL_DIR}/deployment-info.txt"
    echo
    echo -e "${GREEN}${BOLD}✅ Powered by Playwright - Superior reliability and debugging${NC}"
    echo
}

#═══════════════════════════════════════════════════════════════════════════
# INTERACTIVE MENU
#═══════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BLUE}${BOLD}"
    cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                NetSwift 2.0 - Installation Manager                        ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    
    # Check if NetSwift is already installed
    if [[ -d "${INSTALL_DIR}" ]] && [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
        echo -e "${GREEN}Status: NetSwift is installed${NC}"
    else
        echo -e "${YELLOW}Status: NetSwift is not installed${NC}"
    fi
    
    echo ""
    echo "Please select an option:"
    echo ""
    echo "  1) Install NetSwift"
    echo "  2) Update NetSwift (pull latest app and images)"
    echo "  3) Uninstall NetSwift (complete removal)"
    echo "  4) Check Status"
    echo "  5) Exit"
    echo ""
    read -p "Enter your choice [1-5]: " choice
    
    echo "$choice"
}

#═══════════════════════════════════════════════════════════════════════════
# MAIN
#═══════════════════════════════════════════════════════════════════════════

main() {
    # Detect if running interactively (has terminal) or via pipe (curl)
    # If arguments provided OR stdin is not a terminal, run directly without menu
    if [[ $# -gt 0 ]] || [[ ! -t 0 ]]; then
        # Non-interactive mode (piped from curl or has arguments)
        clear
        echo -e "${BLUE}${BOLD}"
        cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║         NetSwift 2.0 - FULLY AUTOMATED Deployment                         ║
║              (JSON Import - Zero Touch Deployment)                        ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
        echo -e "${NC}"
        
        parse_arguments "$@"
        validate_config
        
        log_info "Starting installation..."
        log_info "GitHub Repo: ${GITHUB_REPO}"
        log_info "Branch: ${GITHUB_BRANCH}"
        echo ""
        
        install_netswift
        exit 0
    fi
    
    # Interactive mode - only if running with terminal
    while true; do
        choice=$(show_menu)
        
        case $choice in
            1)
                clear
                echo -e "${BLUE}${BOLD}"
                cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                     NetSwift 2.0 Installation                             ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
                echo -e "${NC}"
                
                if [[ -d "${INSTALL_DIR}" ]]; then
                    echo ""
                    echo -e "${YELLOW}⚠️  NetSwift is already installed${NC}"
                    echo ""
                    read -p "Reinstall? This will preserve your data. (yes/no): " confirm
                    if [[ "${confirm}" != "yes" ]]; then
                        continue
                    fi
                fi
                
                validate_config
                install_netswift
                
                echo ""
                read -p "Press Enter to continue..."
                ;;
            2)
                clear
                echo -e "${BLUE}${BOLD}"
                cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                        NetSwift 2.0 Update                                ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
                echo -e "${NC}"
                
                update_netswift
                
                echo ""
                read -p "Press Enter to continue..."
                ;;
            3)
                clear
                echo -e "${BLUE}${BOLD}"
                cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                      NetSwift 2.0 Uninstall                               ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
                echo -e "${NC}"
                
                uninstall_netswift
                
                echo ""
                read -p "Press Enter to continue..."
                ;;
            4)
                clear
                if [[ -d "${INSTALL_DIR}" ]]; then
                    "${INSTALL_DIR}/status.sh"
                else
                    echo ""
                    echo -e "${YELLOW}NetSwift is not installed${NC}"
                    echo ""
                fi
                
                echo ""
                read -p "Press Enter to continue..."
                ;;
            5)
                clear
                echo ""
                echo -e "${GREEN}Thank you for using NetSwift!${NC}"
                echo ""
                exit 0
                ;;
            *)
                echo ""
                echo -e "${RED}Invalid option. Please try again.${NC}"
                sleep 2
                ;;
        esac
    done
}

main "$@"
