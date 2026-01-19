#!/usr/bin/env python3
"""
Metrics Agent for GPU Nodes (Chimera/Cerberus)
Serves system and GPU metrics as JSON on port 9100
"""

import json
import subprocess
import os
import psutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PORT = int(os.environ.get('METRICS_PORT', 9100))

def get_gpu_metrics():
    """Get GPU metrics using nvidia-smi"""
    gpus = []
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            for line in result.stdout.strip().split('\n'):
                if line:
                    parts = [p.strip() for p in line.split(',')]
                    if len(parts) >= 6:
                        gpus.append({
                            'index': int(parts[0]),
                            'name': parts[1],
                            'utilization_percent': int(parts[2]) if parts[2] != '[N/A]' else 0,
                            'memory_used_gb': round(int(parts[3]) / 1024, 1) if parts[3] != '[N/A]' else 0,
                            'memory_total_gb': round(int(parts[4]) / 1024, 1) if parts[4] != '[N/A]' else 0,
                            'temperature_c': int(parts[5]) if parts[5] != '[N/A]' else 0
                        })
    except Exception as e:
        print(f"Error getting GPU metrics: {e}")
    return gpus

def get_system_metrics():
    """Get CPU, RAM, and disk metrics"""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)

    # Memory
    mem = psutil.virtual_memory()
    ram_used_gb = round(mem.used / (1024**3), 1)
    ram_total_gb = round(mem.total / (1024**3), 1)

    # Disk - root partition
    disk = psutil.disk_usage('/')
    disk_used_gb = round(disk.used / (1024**3), 1)
    disk_total_gb = round(disk.total / (1024**3), 1)

    return {
        'cpu_percent': round(cpu_percent),
        'ram_used_gb': ram_used_gb,
        'ram_total_gb': ram_total_gb,
        'disk_used_gb': disk_used_gb,
        'disk_total_gb': disk_total_gb
    }

def get_container_count():
    """Get count of running Docker containers"""
    try:
        result = subprocess.run(
            ['docker', 'ps', '-q'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return len([l for l in result.stdout.strip().split('\n') if l])
    except:
        pass
    return 0

def collect_metrics():
    """Collect all metrics"""
    return {
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'system': get_system_metrics(),
        'gpus': get_gpu_metrics(),
        'containers': {
            'running': get_container_count()
        }
    }

class MetricsHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default logging
        pass

    def do_GET(self):
        if self.path == '/metrics' or self.path == '/':
            metrics = collect_metrics()
            response = json.dumps(metrics, indent=2)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response.encode())
        elif self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'OK')
        else:
            self.send_response(404)
            self.end_headers()

def main():
    server = HTTPServer(('0.0.0.0', PORT), MetricsHandler)
    print(f"Metrics agent listening on port {PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()

if __name__ == '__main__':
    main()
