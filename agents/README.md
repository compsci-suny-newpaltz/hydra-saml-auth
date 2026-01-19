# Hydra Cluster Metrics Agents

This directory contains the metrics agent for collecting real system and GPU statistics from cluster nodes.

## Quick Start

### Deploy to a GPU Node (Chimera, Cerberus)

```bash
# On Hydra, copy files to the target node
scp metrics-agent.js chimera:/opt/hydra-metrics/
scp hydra-metrics-agent.service chimera:/etc/systemd/system/

# SSH to the node and start the service
ssh chimera
sudo mkdir -p /opt/hydra-metrics
sudo systemctl daemon-reload
sudo systemctl enable --now hydra-metrics-agent

# Verify it's running
curl http://localhost:9100/health
curl http://localhost:9100/metrics
```

### Service Configuration

Edit `/etc/systemd/system/hydra-metrics-agent.service` to customize:

| Variable | Description | Default |
|----------|-------------|---------|
| NODE_NAME | Display name for the node | hostname |
| NODE_ROLE | Role: `worker`, `inference`, `training` | worker |
| PORT | HTTP port for metrics endpoint | 9100 |

### For Chimera (Inference Node)

```bash
# Edit the service file
sudo sed -i 's/NODE_ROLE=worker/NODE_ROLE=inference/' /etc/systemd/system/hydra-metrics-agent.service
sudo systemctl daemon-reload
sudo systemctl restart hydra-metrics-agent
```

### For Cerberus (Training Node)

```bash
sudo sed -i 's/NODE_ROLE=worker/NODE_ROLE=training/' /etc/systemd/system/hydra-metrics-agent.service
sudo systemctl daemon-reload
sudo systemctl restart hydra-metrics-agent
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /metrics` | Returns JSON with all node metrics |
| `GET /health` | Health check endpoint |

## Metrics Response Format

```json
{
  "hostname": "chimera",
  "role": "inference",
  "timestamp": "2025-01-19T12:00:00.000Z",
  "gpus": [
    {
      "index": 0,
      "name": "NVIDIA GeForce RTX 3090",
      "utilization_percent": 75,
      "memory_used_gb": 18.5,
      "memory_total_gb": 24,
      "temperature_c": 72,
      "power_draw_w": 280
    }
  ],
  "system": {
    "cpu_percent": 45,
    "ram_used_gb": 128,
    "ram_total_gb": 256,
    "disk_used_gb": 800,
    "disk_total_gb": 2000,
    "load_average": [2.5, 2.1, 1.8],
    "uptime_hours": 720
  },
  "containers": {
    "running": 8,
    "paused": 0,
    "stopped": 2
  }
}
```

## Requirements

- Node.js 18+
- nvidia-smi (for GPU metrics)
- Docker (for container count)

## Firewall

Ensure port 9100 is accessible from Hydra (192.168.1.100):

```bash
sudo ufw allow from 192.168.1.100 to any port 9100
```
