#!/bin/bash

# MPC-Enabled Trading Server Deployment Script
# This script handles deployment with MPC wallet support

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required tools are installed
check_dependencies() {
    print_info "Checking dependencies..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is required but not installed."
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is required but not installed."
        exit 1
    fi

    print_success "Dependencies check passed"
}

# Validate environment configuration
validate_config() {
    print_info "Validating configuration..."

    # Check if .env file exists
    if [ ! -f .env ]; then
        print_warning ".env file not found. Creating from template..."
        cp .env.example .env
        print_warning "Please edit .env file with your configuration before proceeding"
        exit 1
    fi

    # Check MPC configuration if enabled
    if grep -q "MPC_ENABLED=true" .env; then
        print_info "MPC wallet is enabled, validating MPC configuration..."

        # Check for required MPC environment variables
        required_vars=("MPC_WALLET_ID" "MPC_API_KEY" "MPC_API_SECRET" "MPC_API_URL")
        for var in "${required_vars[@]}"; do
            if ! grep -q "^${var}=" .env; then
                print_error "MPC is enabled but ${var} is not configured in .env"
                exit 1
            fi
        done

        print_success "MPC configuration validated"
    else
        print_info "MPC wallet is disabled, using legacy single-key mode"
    fi

    print_success "Configuration validation passed"
}

# Create secrets directory and files
setup_secrets() {
    print_info "Setting up secrets..."

    # Create secrets directory
    mkdir -p secrets

    # Create MPC credential files if MPC is enabled
    if grep -q "MPC_ENABLED=true" .env; then
        # Extract MPC credentials from .env and create secret files
        grep "MPC_WALLET_ID=" .env | cut -d'=' -f2 > secrets/mpc-wallet-secret.txt
        grep "MPC_API_SECRET=" .env | cut -d'=' -f2 > secrets/mpc-api-secret.txt

        print_success "MPC secrets configured"
    else
        # Create empty secret files for consistency
        touch secrets/mpc-wallet-secret.txt secrets/mpc-api-secret.txt
        print_info "MPC secrets not required (MPC disabled)"
    fi
}

# Build and deploy the application
deploy() {
    print_info "Building and deploying application..."

    # Build the Docker image
    print_info "Building Docker image..."
    docker-compose build --no-cache

    # Stop any existing containers
    print_info "Stopping existing containers..."
    docker-compose down || true

    # Start the application
    print_info "Starting application..."
    docker-compose up -d

    # Wait for health check
    print_info "Waiting for application to be healthy..."
    sleep 10

    # Check if application is running
    if docker-compose ps | grep -q "trading-server.*Up"; then
        print_success "Application deployed successfully"

        # Show container information
        print_info "Container status:"
        docker-compose ps

        print_info "Application logs:"
        docker-compose logs --tail=10 trading-server

    else
        print_error "Application failed to start properly"
        print_info "Check logs with: docker-compose logs trading-server"
        exit 1
    fi
}

# Health check function
health_check() {
    print_info "Performing health check..."

    local max_attempts=10
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -f http://localhost:3000/health &>/dev/null; then
            print_success "Health check passed"
            return 0
        fi

        print_info "Health check attempt $attempt/$max_attempts failed, retrying..."
        sleep 5
        ((attempt++))
    done

    print_error "Health check failed after $max_attempts attempts"
    return 1
}

# Cleanup function
cleanup() {
    print_info "Cleaning up..."

    # Remove any dangling images
    docker image prune -f

    print_success "Cleanup completed"
}

# Main deployment flow
main() {
    print_info "Starting MPC-enabled trading server deployment..."

    check_dependencies
    validate_config
    setup_secrets
    deploy
    health_check
    cleanup

    print_success "Deployment completed successfully!"
    print_info ""
    print_info "Application is running at: http://localhost:3000"
    print_info "View logs with: docker-compose logs -f trading-server"
    print_info "Stop application with: docker-compose down"
    print_info ""
    print_info "MPC Setup Guide: See MPC_SETUP.md for detailed configuration"
}

# Handle script arguments
case "${1:-}" in
    "build")
        check_dependencies
        validate_config
        docker-compose build
        print_success "Build completed"
        ;;
    "deploy")
        main
        ;;
    "health")
        health_check
        ;;
    "cleanup")
        cleanup
        ;;
    "help"|"-h"|"--help")
        echo "MPC-Enabled Trading Server Deployment Script"
        echo ""
        echo "Usage: $0 [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  build    - Build Docker image only"
        echo "  deploy   - Full deployment (default)"
        echo "  health   - Perform health check"
        echo "  cleanup  - Clean up Docker resources"
        echo "  help     - Show this help message"
        echo ""
        echo "Environment Variables:"
        echo "  MPC_ENABLED=true/false          - Enable MPC wallet"
        echo "  MPC_PROVIDER=mock/fireblocks    - MPC provider type"
        echo "  MPC_WALLET_ID=your-wallet-id    - MPC wallet identifier"
        echo "  MPC_API_KEY=your-api-key        - MPC API key"
        echo "  MPC_API_SECRET=your-secret      - MPC API secret"
        echo ""
        ;;
    *)
        main
        ;;
esac
