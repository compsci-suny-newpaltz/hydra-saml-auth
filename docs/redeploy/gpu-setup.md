# GPU Setup Guide

NVIDIA driver and container toolkit setup for Chimera and Cerberus.

## Hardware

| Node | GPUs | VRAM | Use |
|------|------|------|-----|
| Chimera | 3x RTX 3090 | 72GB total | Ollama inference |
| Cerberus | 2x RTX 5090 | ~64GB total | Training |

## Install NVIDIA Drivers

### Option 1: Ubuntu Drivers (Recommended)

```bash
sudo apt update
sudo ubuntu-drivers autoinstall
sudo reboot
```

### Option 2: Manual Install

```bash
# Add NVIDIA repo
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:graphics-drivers/ppa
sudo apt update

# Install specific version
sudo apt install -y nvidia-driver-550

sudo reboot
```

### Verify

```bash
nvidia-smi
```

Should show all GPUs with driver version.

## Install NVIDIA Container Toolkit

Required for Docker GPU access:

```bash
# Add repo
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit

# Configure Docker
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Verify Container GPU Access

```bash
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

## Ollama GPU Configuration

In `chimera_docker/docker-compose.yaml`:

```yaml
ollama:
  image: ollama/ollama:latest
  environment:
    - NVIDIA_VISIBLE_DEVICES=0,1,2    # All 3 GPUs
    - OLLAMA_NUM_GPU=3
    - OLLAMA_FLASH_ATTENTION=1
    - OLLAMA_MAX_LOADED_MODELS=6
    - OLLAMA_KEEP_ALIVE=-1
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 3
            capabilities: [gpu]
```

## GPU Auto-Fix Script

Ollama can lose GPU access after driver updates or Docker restarts.

Install on Chimera:

```bash
sudo tee /usr/local/bin/gpu-monitor.sh << 'EOF'
#!/bin/bash
LOG_FILE="/var/log/gpu-monitor.log"
COMPOSE_DIR="/home/infra/hydra-saml-auth/chimera_docker"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

if ! docker ps --format '{{.Names}}' | grep -q "^ollama$"; then
    log "WARN: Ollama not running, starting..."
    cd "$COMPOSE_DIR" && docker compose up -d ollama
    sleep 5
fi

GPU_TEST=$(docker exec ollama nvidia-smi 2>&1)

if echo "$GPU_TEST" | grep -q "NVIDIA-SMI"; then
    log "OK: GPU access working"
else
    log "ERROR: GPU access failed, recreating container..."
    docker stop ollama 2>/dev/null
    docker rm ollama 2>/dev/null
    cd "$COMPOSE_DIR" && docker compose up -d ollama
    sleep 10
    if docker exec ollama nvidia-smi 2>&1 | grep -q "NVIDIA-SMI"; then
        log "FIXED: GPU access restored"
    else
        log "CRITICAL: GPU fix failed"
    fi
fi
EOF

sudo chmod +x /usr/local/bin/gpu-monitor.sh
sudo touch /var/log/gpu-monitor.log

# Cron every 5 minutes
(sudo crontab -l 2>/dev/null | grep -v gpu-monitor; echo "*/5 * * * * /usr/local/bin/gpu-monitor.sh") | sudo crontab -
```

## Troubleshooting

### nvidia-smi: command not found

Driver not installed:
```bash
sudo ubuntu-drivers autoinstall
sudo reboot
```

### nvidia-smi shows GPUs but Docker can't access

Container toolkit not configured:
```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Container shows "Failed to initialize NVML"

Container needs recreation (not just restart):
```bash
docker stop ollama && docker rm ollama
docker compose up -d ollama
```

### Only some GPUs visible

Check `NVIDIA_VISIBLE_DEVICES`:
```bash
# Show all
NVIDIA_VISIBLE_DEVICES=all

# Or specific
NVIDIA_VISIBLE_DEVICES=0,1,2
```

### GPU memory full

Check what's using it:
```bash
nvidia-smi

# Kill stuck processes
sudo fuser -v /dev/nvidia*
sudo kill -9 <PID>
```

## Performance Tuning

### Persistence Mode

Keeps GPU initialized (faster cold starts):
```bash
sudo nvidia-smi -pm 1
```

### Power Limit (reduce heat/noise)

```bash
# Set to 300W (from 350W default)
sudo nvidia-smi -pl 300
```

### Fan Control (if overheating)

```bash
# Set fan to 80%
sudo nvidia-settings -a "[gpu:0]/GPUFanControlState=1" -a "[fan:0]/GPUTargetFanSpeed=80"
```
