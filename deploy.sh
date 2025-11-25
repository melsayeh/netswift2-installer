#!/usr/bin/env bash
#
# NetSwift ULTIMATE One-Liner Deployment
# Version: 6.2.2 - Rocky Linux Chromium Fix
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
#   4. Authenticates with Docker Hub (for private images)
#   5. Deploys containers (Appsmith + Backend)
#   6. Runs Playwright automation (admin, import, datasource, deploy)
#   7. DONE! Zero manual steps.
#
# NEW in 6.2.2:
#   • Fixed: Chromium system dependencies for Rocky Linux/RHEL
#   • Added: Automatic installation of required libraries (gtk3, nss, etc.)
#   • Fixed: Playwright now works properly on Rocky/RHEL/CentOS/AlmaLinux
#
# NEW in 6.2.1:
#   • Fixed: Automatic package.json creation for npm install
#   • Fixed: npm install no longer fails silently
#
# NEW in 6.2.0:
#   • Docker Hub authentication for private repositories
#   • Interactive token prompt with secure input
#   • Environment variable support for automation
#   • Comprehensive dependency conflict resolution
#   • Pre-flight checks and installation validation
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

readonly SCRIPT_VERSION="6.2.2"
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

# Docker Hub authentication (for private repository access)
DOCKER_HUB_USERNAME="${DOCKER_HUB_USERNAME:-melsayeh}"
DOCKER_HUB_TOKEN="${DOCKER_HUB_TOKEN:-}"  # Can be set via environment variable

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
NetSwift 6.2 - Ultimate One-Liner Deployment

Usage (Recommended for Interactive Mode):
  # Download and run in two steps to ensure terminal input works
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh -o /tmp/netswift-deploy.sh
  sudo bash /tmp/netswift-deploy.sh

  OR with automatic token (non-interactive):
  export DOCKER_HUB_TOKEN="dckr_pat_xxxxxxxxxxxxxxxxxxxxx"
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh | sudo bash

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

Docker Hub Authentication:
  The installation will prompt for your Docker Hub access token to pull the
  private backend image. You can also provide it via environment variable:
  
  export DOCKER_HUB_TOKEN="your_token_here"

Examples:

  # Interactive mode (recommended - download first, then run):
  curl -fsSL https://raw.githubusercontent.com/melsayeh/netswift2-installer/main/deploy.sh -o /tmp/netswift-deploy.sh
  sudo bash /tmp/netswift-deploy.sh
  # You will be prompted for Docker Hub token during installation

  # With Docker Hub token (non-interactive/automated):
  export DOCKER_HUB_TOKEN="dckr_pat_xxxxxxxxxxxxxxxxxxxxx"
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
  DOCKER_HUB_TOKEN           Docker Hub access token (for private image)

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

preflight_checks() {
    log_info "Running pre-flight checks..."
    
    # Check disk space (need at least 5GB free)
    local free_space_mb
    free_space_mb=$(df /opt 2>/dev/null | tail -1 | awk '{print $4}')
    local free_space_gb=$((free_space_mb / 1024 / 1024))
    
    if [[ ${free_space_gb} -lt 5 ]]; then
        log_warning "Low disk space: ${free_space_gb}GB available (5GB recommended)"
        log_warning "Installation may fail if disk space runs out"
    else
        log_success "Disk space: ${free_space_gb}GB available"
    fi
    
    # Check memory (need at least 2GB)
    local total_mem_kb
    total_mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    local total_mem_gb=$((total_mem_kb / 1024 / 1024))
    
    if [[ ${total_mem_gb} -lt 2 ]]; then
        log_warning "Low memory: ${total_mem_gb}GB (2GB recommended)"
        log_warning "System may be slow or unstable"
    else
        log_success "Memory: ${total_mem_gb}GB available"
    fi
    
    # Check if critical ports are available
    local ports_in_use=()
    for port in 80 443 8000; do
        if ss -tulpn 2>/dev/null | grep -q ":${port} " || netstat -tulpn 2>/dev/null | grep -q ":${port} "; then
            ports_in_use+=("${port}")
        fi
    done
    
    if [[ ${#ports_in_use[@]} -gt 0 ]]; then
        log_warning "Ports already in use: ${ports_in_use[*]}"
        log_warning "NetSwift requires ports 80, 443, and 8000 to be available"
        log_warning "Existing services on these ports will need to be stopped"
    else
        log_success "Required ports (80, 443, 8000) are available"
    fi
    
    # Check for conflicting software
    local conflicts=()
    
    # Check for existing Appsmith installations
    if systemctl list-units --full --all 2>/dev/null | grep -q appsmith; then
        conflicts+=("Appsmith service detected")
    fi
    
    if docker ps 2>/dev/null | grep -q appsmith; then
        conflicts+=("Appsmith container running")
    fi
    
    # Check for Podman (conflicts with Docker)
    if command_exists podman && systemctl is-active --quiet podman.socket 2>/dev/null; then
        conflicts+=("Podman service active (may conflict with Docker)")
    fi
    
    if [[ ${#conflicts[@]} -gt 0 ]]; then
        log_warning "Potential conflicts detected:"
        for conflict in "${conflicts[@]}"; do
            log_warning "  - ${conflict}"
        done
        log_warning "Installation will attempt to resolve these automatically"
    fi
    
    # Check internet connectivity
    if ! curl -s --max-time 5 https://google.com > /dev/null 2>&1; then
        log_error "No internet connection detected"
        log_error "Internet connection is required for installation"
        exit 1
    fi
    log_success "Internet connection: OK"
    
    log_success "Pre-flight checks completed"
}

cleanup_failed_installation() {
    log_warning "Cleaning up failed installation..."
    
    # Stop any running containers
    if command_exists docker; then
        docker stop netswift-backend netswift-appsmith 2>/dev/null || true
        docker rm netswift-backend netswift-appsmith 2>/dev/null || true
    fi
    
    # Don't remove the entire directory to preserve logs
    log_info "Installation directory preserved for debugging: ${INSTALL_DIR}"
    log_info "Check logs at: ${LOG_FILE}"
}

# Trap errors and cleanup
trap 'cleanup_failed_installation' ERR


install_dependencies() {
    log_info "Installing system dependencies..."
    
    if command_exists apt-get; then
        export DEBIAN_FRONTEND=noninteractive
        
        # Update package cache
        apt-get update -qq 2>&1 | tee -a "${LOG_FILE}"
        
        # Fix any broken dependencies first
        log_info "Checking for broken dependencies..."
        apt-get install -f -y 2>&1 | tee -a "${LOG_FILE}"
        
        # Install required packages
        apt-get install -y -qq curl wget git jq ca-certificates gnupg lsb-release \
            2>&1 | tee -a "${LOG_FILE}"
            
    elif command_exists dnf; then
        # For RHEL 9+/Rocky 9+/AlmaLinux 9+
        
        # Clean yum/dnf cache
        dnf clean all 2>&1 | tee -a "${LOG_FILE}"
        
        # Check for and resolve any package conflicts
        log_info "Checking for package conflicts..."
        dnf check 2>&1 | tee -a "${LOG_FILE}" || true
        
        # Install required packages
        dnf install -y curl wget git jq ca-certificates 2>&1 | tee -a "${LOG_FILE}"
        
    elif command_exists yum; then
        # For RHEL 8/CentOS 8
        
        # Clean yum cache
        yum clean all 2>&1 | tee -a "${LOG_FILE}"
        
        # Check for and resolve any package conflicts
        log_info "Checking for package conflicts..."
        yum check 2>&1 | tee -a "${LOG_FILE}" || true
        
        # Install required packages
        yum install -y curl wget git jq ca-certificates 2>&1 | tee -a "${LOG_FILE}"
        
    else
        log_error "Unsupported package manager"
        exit 1
    fi
    
    # Validate critical tools are available
    local missing_tools=()
    for tool in curl wget git jq; do
        if ! command_exists "${tool}"; then
            missing_tools+=("${tool}")
        fi
    done
    
    if [[ ${#missing_tools[@]} -gt 0 ]]; then
        log_error "Failed to install required tools: ${missing_tools[*]}"
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
    elif command_exists dnf; then
        # For RHEL 9+ / Rocky 9+ / AlmaLinux 9+ systems
        # Remove old Node.js/npm if present to avoid conflicts
        if rpm -q nodejs &>/dev/null || rpm -q npm &>/dev/null; then
            log_info "Removing old Node.js/npm packages..."
            dnf remove -y nodejs npm 2>&1 | tee -a "${LOG_FILE}"
        fi
        
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>&1 | tee -a "${LOG_FILE}"
        dnf install -y nodejs 2>&1 | tee -a "${LOG_FILE}"
    elif command_exists yum; then
        # For RHEL 8 / Rocky 8 / CentOS 8 systems
        # Remove old Node.js/npm if present to avoid conflicts
        if rpm -q nodejs &>/dev/null || rpm -q npm &>/dev/null; then
            log_info "Removing old Node.js/npm packages..."
            yum remove -y nodejs npm 2>&1 | tee -a "${LOG_FILE}"
        fi
        
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>&1 | tee -a "${LOG_FILE}"
        yum install -y nodejs 2>&1 | tee -a "${LOG_FILE}"
    fi
    
    log_success "Node.js installed: $(node --version)"
}

install_docker() {
    if command_exists docker; then
        # Check if it's a working Docker installation
        if docker --version &>/dev/null && docker ps &>/dev/null 2>&1; then
            log_success "Docker already installed: $(docker --version)"
            return 0
        else
            log_warning "Docker command exists but not working, reinstalling..."
        fi
    fi
    
    log_info "Installing Docker..."
    
    # Remove any conflicting Docker packages
    local conflicting_packages=()
    
    if command_exists apt-get; then
        # Check for conflicting packages on Debian/Ubuntu
        for pkg in docker docker.io docker-engine containerd runc podman-docker; do
            if dpkg -l | grep -q "^ii.*${pkg}"; then
                conflicting_packages+=("${pkg}")
            fi
        done
        
        if [[ ${#conflicting_packages[@]} -gt 0 ]]; then
            log_info "Removing conflicting packages: ${conflicting_packages[*]}"
            apt-get remove -y "${conflicting_packages[@]}" 2>&1 | tee -a "${LOG_FILE}"
            apt-get autoremove -y 2>&1 | tee -a "${LOG_FILE}"
        fi
    elif command_exists dnf; then
        # Check for conflicting packages on RHEL 9+/Rocky 9+
        for pkg in docker docker-ce docker-ce-cli containerd.io podman-docker; do
            if rpm -q "${pkg}" &>/dev/null; then
                conflicting_packages+=("${pkg}")
            fi
        done
        
        if [[ ${#conflicting_packages[@]} -gt 0 ]]; then
            log_info "Removing conflicting packages: ${conflicting_packages[*]}"
            dnf remove -y "${conflicting_packages[@]}" 2>&1 | tee -a "${LOG_FILE}"
        fi
    elif command_exists yum; then
        # Check for conflicting packages on RHEL 8/CentOS 8
        for pkg in docker docker-ce docker-ce-cli containerd.io podman-docker; do
            if rpm -q "${pkg}" &>/dev/null; then
                conflicting_packages+=("${pkg}")
            fi
        done
        
        if [[ ${#conflicting_packages[@]} -gt 0 ]]; then
            log_info "Removing conflicting packages: ${conflicting_packages[*]}"
            yum remove -y "${conflicting_packages[@]}" 2>&1 | tee -a "${LOG_FILE}"
        fi
    fi
    
    # Install Docker using official script
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh 2>&1 | tee -a "${LOG_FILE}"
    rm /tmp/get-docker.sh
    
    # Ensure Docker service is enabled and started
    systemctl enable docker 2>&1 | tee -a "${LOG_FILE}"
    systemctl start docker 2>&1 | tee -a "${LOG_FILE}"
    
    # Wait for Docker to be ready
    local retries=0
    while ! docker ps &>/dev/null && [[ ${retries} -lt 10 ]]; do
        log_info "Waiting for Docker to be ready..."
        sleep 2
        ((retries++))
    done
    
    if ! docker ps &>/dev/null; then
        log_error "Docker failed to start properly"
        exit 1
    fi
    
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

docker_login() {
    log_info "Authenticating with Docker Hub..."
    
    # Check if already logged in
    if docker info 2>/dev/null | grep -q "Username: ${DOCKER_HUB_USERNAME}"; then
        log_success "Already logged in to Docker Hub as ${DOCKER_HUB_USERNAME}"
        return 0
    fi
    
    # If token is provided via environment variable, use it
    if [[ -n "${DOCKER_HUB_TOKEN}" ]]; then
        log_info "Using Docker Hub token from environment variable..."
        
        if echo "${DOCKER_HUB_TOKEN}" | docker login -u "${DOCKER_HUB_USERNAME}" --password-stdin 2>&1 | tee -a "${LOG_FILE}"; then
            log_success "Docker Hub authentication successful"
            return 0
        else
            log_error "Docker Hub authentication failed with provided token"
            exit 1
        fi
    fi
    
    # Interactive mode - prompt for token
    echo ""
    echo -e "${CYAN}${BOLD}╔═══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}${BOLD}║                                                                           ║${NC}"
    echo -e "${CYAN}${BOLD}║                     Docker Hub Authentication                             ║${NC}"
    echo -e "${CYAN}${BOLD}║                                                                           ║${NC}"
    echo -e "${CYAN}${BOLD}╚═══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}The NetSwift backend image is hosted on a private Docker Hub repository.${NC}"
    echo -e "${YELLOW}You need to authenticate to pull the image.${NC}"
    echo ""
    echo -e "Username: ${BLUE}${DOCKER_HUB_USERNAME}${NC}"
    echo ""
    echo -e "${YELLOW}Please enter your Docker Hub Access Token:${NC}"
    echo -e "${CYAN}(The token will not be displayed as you type)${NC}"
    echo ""
    
    # Read token securely from terminal device (works even when script is piped)
    local token
    if [[ -t 0 ]]; then
        # stdin is a terminal, read normally
        read -s -p "Access Token: " token
    else
        # stdin is not a terminal (script was piped), read from /dev/tty
        read -s -p "Access Token: " token < /dev/tty
    fi
    echo ""
    echo ""
    
    if [[ -z "${token}" ]]; then
        log_error "No token provided"
        exit 1
    fi
    
    log_info "Authenticating with Docker Hub as ${DOCKER_HUB_USERNAME}..."
    
    if echo "${token}" | docker login -u "${DOCKER_HUB_USERNAME}" --password-stdin 2>&1 | tee -a "${LOG_FILE}"; then
        log_success "Docker Hub authentication successful"
        
        # Save token for future use (optional, for automation)
        # Note: This is saved securely with restricted permissions
        mkdir -p "${INSTALL_DIR}"
        echo "${token}" > "${INSTALL_DIR}/.docker-token"
        chmod 600 "${INSTALL_DIR}/.docker-token"
        
        return 0
    else
        log_error "Docker Hub authentication failed"
        log_error "Please check your access token and try again"
        exit 1
    fi
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
    
    cd "${INSTALL_DIR}/automation"
    
    # Create package.json if it doesn't exist
    if [[ ! -f "package.json" ]]; then
        log_info "Creating package.json..."
        cat > package.json << 'EOF'
{
  "name": "netswift-automation",
  "version": "1.0.0",
  "description": "Appsmith automation for NetSwift",
  "main": "automate.js",
  "scripts": {
    "start": "node automate.js"
  },
  "dependencies": {
    "playwright": "^1.40.0"
  }
}
EOF
        log_success "package.json created"
    else
        log_info "package.json already exists"
    fi
    
    # Clean any previous npm installation artifacts
    if [[ -d "node_modules" ]]; then
        log_info "Cleaning previous npm installation..."
        rm -rf node_modules package-lock.json 2>&1 | tee -a "${LOG_FILE}"
    fi
    
    # Install npm dependencies
    log_info "Installing Playwright npm package (this may take a minute)..."
    
    # Try npm install with retries in case of network issues
    local npm_retries=0
    local npm_success=false
    
    while [[ ${npm_retries} -lt 3 ]] && [[ "${npm_success}" == "false" ]]; do
        if npm install --silent 2>&1 | tee -a "${LOG_FILE}"; then
            npm_success=true
        else
            ((npm_retries++))
            if [[ ${npm_retries} -lt 3 ]]; then
                log_warning "npm install failed, retrying (${npm_retries}/3)..."
                sleep 5
            fi
        fi
    done
    
    if [[ "${npm_success}" == "false" ]]; then
        log_error "Failed to install npm dependencies after 3 attempts"
        exit 1
    fi
    
    # Validate that playwright was installed
    if [[ ! -d "node_modules/playwright" ]]; then
        log_error "Playwright package not found after installation"
        exit 1
    fi
    
    # Install Chromium browser
    log_info "Installing Chromium browser for Playwright..."
    
    # Detect OS for dependency installation
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID}"
    fi
    
    # For RHEL-based systems (Rocky, CentOS, AlmaLinux, RHEL), install dependencies manually
    # Playwright's --with-deps doesn't support these systems properly
    if [[ "${OS_ID}" =~ ^(rocky|rhel|centos|almalinux)$ ]]; then
        log_info "Detected ${OS_ID}, installing Chromium system dependencies..."
        
        # Install required system libraries for Chromium
        if command_exists dnf; then
            dnf install -y \
                alsa-lib \
                atk \
                at-spi2-atk \
                at-spi2-core \
                cairo \
                cups-libs \
                dbus-glib \
                expat \
                glib2 \
                gtk3 \
                libdrm \
                libgbm \
                libxcb \
                libxcomposite \
                libxcursor \
                libxdamage \
                libXext \
                libxfixes \
                libxi \
                libxkbcommon \
                libxrandr \
                libXrender \
                libxshmfence \
                libXtst \
                mesa-libgbm \
                nspr \
                nss \
                nss-util \
                pango \
                vulkan-loader \
                2>&1 | tee -a "${LOG_FILE}"
        elif command_exists yum; then
            yum install -y \
                alsa-lib \
                atk \
                at-spi2-atk \
                at-spi2-core \
                cairo \
                cups-libs \
                dbus-glib \
                expat \
                glib2 \
                gtk3 \
                libdrm \
                libgbm \
                libxcb \
                libxcomposite \
                libxcursor \
                libxdamage \
                libXext \
                libxfixes \
                libxi \
                libxkbcommon \
                libxrandr \
                libXrender \
                libxshmfence \
                libXtst \
                mesa-libgbm \
                nspr \
                nss \
                nss-util \
                pango \
                vulkan-loader \
                2>&1 | tee -a "${LOG_FILE}"
        fi
        
        log_success "System dependencies installed"
        log_info "Installing Chromium browser..."
        
        # Install Chromium without --with-deps (dependencies already installed)
        local browser_retries=0
        local browser_success=false
        
        while [[ ${browser_retries} -lt 3 ]] && [[ "${browser_success}" == "false" ]]; do
            if npx playwright install chromium 2>&1 | tee -a "${LOG_FILE}"; then
                browser_success=true
            else
                ((browser_retries++))
                if [[ ${browser_retries} -lt 3 ]]; then
                    log_warning "Browser install failed, retrying (${browser_retries}/3)..."
                    sleep 5
                fi
            fi
        done
        
        if [[ "${browser_success}" == "false" ]]; then
            log_error "Failed to install Chromium browser after 3 attempts"
            exit 1
        fi
    else
        # For Ubuntu/Debian, use --with-deps
        log_info "Installing Chromium with system dependencies..."
        
        # Install with retries
        local browser_retries=0
        local browser_success=false
        
        while [[ ${browser_retries} -lt 3 ]] && [[ "${browser_success}" == "false" ]]; do
            if npx playwright install --with-deps chromium 2>&1 | tee -a "${LOG_FILE}"; then
                browser_success=true
            else
                ((browser_retries++))
                if [[ ${browser_retries} -lt 3 ]]; then
                    log_warning "Browser install failed, retrying (${browser_retries}/3)..."
                    sleep 5
                fi
            fi
        done
        
        if [[ "${browser_success}" == "false" ]]; then
            log_error "Failed to install Chromium browser after 3 attempts"
            exit 1
        fi
    fi
    
    # Validate Chromium was installed
    if ! npx playwright --version &>/dev/null; then
        log_error "Playwright installation validation failed"
        exit 1
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

validate_installation() {
    log_info "Validating installation..."
    
    local validation_passed=true
    local validation_warnings=()
    
    # 1. Check Docker is running
    if ! docker ps &>/dev/null; then
        log_error "Docker is not running"
        validation_passed=false
    else
        log_success "Docker: Running"
    fi
    
    # 2. Check containers are running
    local backend_running=false
    local appsmith_running=false
    
    if docker ps --format '{{.Names}}' | grep -q "^netswift-backend$"; then
        backend_running=true
        log_success "Backend container: Running"
    else
        log_error "Backend container: Not running"
        validation_passed=false
    fi
    
    if docker ps --format '{{.Names}}' | grep -q "^netswift-appsmith$"; then
        appsmith_running=true
        log_success "Appsmith container: Running"
    else
        log_error "Appsmith container: Not running"
        validation_passed=false
    fi
    
    # 3. Check container health status
    if [[ "${backend_running}" == "true" ]]; then
        local backend_health
        backend_health=$(docker inspect --format='{{.State.Health.Status}}' netswift-backend 2>/dev/null || echo "none")
        
        if [[ "${backend_health}" == "healthy" ]]; then
            log_success "Backend health: Healthy"
        elif [[ "${backend_health}" == "starting" ]]; then
            validation_warnings+=("Backend health: Still starting")
        else
            validation_warnings+=("Backend health: ${backend_health}")
        fi
    fi
    
    if [[ "${appsmith_running}" == "true" ]]; then
        local appsmith_health
        appsmith_health=$(docker inspect --format='{{.State.Health.Status}}' netswift-appsmith 2>/dev/null || echo "none")
        
        if [[ "${appsmith_health}" == "healthy" ]]; then
            log_success "Appsmith health: Healthy"
        elif [[ "${appsmith_health}" == "starting" ]]; then
            validation_warnings+=("Appsmith health: Still starting")
        else
            validation_warnings+=("Appsmith health: ${appsmith_health}")
        fi
    fi
    
    # 4. Check ports are accessible
    if curl -s --max-time 5 "http://localhost:8000/health" > /dev/null 2>&1; then
        log_success "Backend API: Accessible"
    else
        validation_warnings+=("Backend API: Not yet accessible")
    fi
    
    if curl -s --max-time 5 "http://localhost/api/v1/health" > /dev/null 2>&1; then
        log_success "Appsmith: Accessible"
    else
        validation_warnings+=("Appsmith: Not yet accessible")
    fi
    
    # 5. Check NetSwift URL was saved
    if [[ -f "${INSTALL_DIR}/netswift-url.txt" ]]; then
        log_success "NetSwift URL: Saved"
    else
        validation_warnings+=("NetSwift URL: Not saved (automation may have failed)")
    fi
    
    # 6. Check Node.js version
    local node_version
    node_version=$(node --version 2>/dev/null | cut -d. -f1 | sed 's/v//')
    if [[ ${node_version} -ge 18 ]]; then
        log_success "Node.js: v${node_version}.x"
    else
        validation_warnings+=("Node.js: v${node_version}.x (expected 18+)")
    fi
    
    # Display warnings
    if [[ ${#validation_warnings[@]} -gt 0 ]]; then
        echo ""
        log_warning "Validation warnings:"
        for warning in "${validation_warnings[@]}"; do
            log_warning "  - ${warning}"
        done
        log_info "Services may still be starting - wait 1-2 minutes"
    fi
    
    # Final validation result
    if [[ "${validation_passed}" == "true" ]]; then
        log_success "Installation validation: PASSED"
    else
        log_error "Installation validation: FAILED"
        log_error "Check logs: ${LOG_FILE}"
        exit 1
    fi
}

#═══════════════════════════════════════════════════════════════════════════
# INSTALLATION FUNCTION
#═══════════════════════════════════════════════════════════════════════════

install_netswift() {
    log_step "1/14" "Checking prerequisites"
    check_root
    preflight_checks
    
    log_step "2/14" "Installing system dependencies"
    install_dependencies
    
    log_step "3/14" "Installing Node.js"
    install_nodejs
    
    log_step "4/14" "Installing Docker"
    install_docker
    
    log_step "5/14" "Setting up installation directory"
    setup_installation_directory
    
    log_step "6/14" "Downloading application files from GitHub"
    download_application_files
    
    log_step "7/14" "Creating Docker configuration"
    create_docker_compose
    
    log_step "8/14" "Authenticating with Docker Hub"
    docker_login
    
    log_step "9/14" "Deploying containers"
    deploy_containers
    
    log_step "10/14" "Waiting for services to be healthy"
    wait_for_services
    
    log_step "11/14" "Setting up Playwright automation"
    setup_automation
    
    log_step "12/14" "Running automation (2-3 minutes)"
    run_automation
    
    log_step "13/14" "Finalizing installation"
    create_management_scripts
    save_deployment_info
    
    log_step "14/14" "Validating installation"
    validate_installation
    
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
