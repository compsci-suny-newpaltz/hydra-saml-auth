# Custom Supervisord Services

This directory is for adding your own custom services that will run automatically in your container.

## How to Add a Custom Service

1. Create a `.conf` file in this directory (e.g., `myapp.conf`)
2. Restart your container or reload supervisord: `sudo supervisorctl reread && sudo supervisorctl update`

## Auto-Discovery for Port Routing

You can add special comments to your supervisor configs to enable **automatic service discovery** from the dashboard. This allows you to add routes without manually entering port and endpoint information.

Add these comments anywhere in your `.conf` file:

```ini
# hydra.port=3000
# hydra.endpoint=myapp
```

Then click "Discover Services" in the dashboard's Port Routing section to automatically detect and add routes for your services.

### Example: Web App with Auto-Discovery

Create `~/supervisor.d/webapp.conf`:

```ini
# hydra.port=3000
# hydra.endpoint=webapp

[program:webapp]
command=node /home/student/myapp/server.js
directory=/home/student/myapp
user=student
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/webapp.log
stderr_logfile=/var/log/supervisor/webapp_err.log
environment=HOME="/home/student",USER="student",PORT="3000"
```

After saving, go to the dashboard and click "Discover Services" - your webapp will appear and you can add it with one click.

## Example: Basic Web Application (Manual Routing)

Create `~/supervisor.d/webapp.conf`:

```ini
[program:webapp]
command=node /home/student/myapp/server.js
directory=/home/student/myapp
user=student
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/webapp.log
stderr_logfile=/var/log/supervisor/webapp_err.log
environment=HOME="/home/student",USER="student",PORT="3000"
```

## Example: Python Flask App

Create `~/supervisor.d/flask.conf`:

```ini
# hydra.port=5000
# hydra.endpoint=flask

[program:flaskapp]
command=/home/student/.local/bin/python /home/student/flask-app/app.py
directory=/home/student/flask-app
user=student
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/flask.log
stderr_logfile=/var/log/supervisor/flask_err.log
environment=HOME="/home/student",USER="student",FLASK_APP="app.py"
```

## Example: Background Worker

Create `~/supervisor.d/worker.conf`:

```ini
[program:worker]
command=/home/student/myapp/worker.sh
directory=/home/student/myapp
user=student
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/worker.log
stderr_logfile=/var/log/supervisor/worker_err.log
```

## Using Docker & Docker Compose

Your container includes a full Docker environment. You can build images, run containers, and use Docker Compose just like on your own machine.

### Quick Start

```bash
# Verify Docker is working
docker ps

# Run a container
docker run --rm hello-world

# Build and run a project with Docker Compose
cd ~/myproject
docker compose up -d
```

### Example: Running a Docker Compose Project

If your project has a `docker-compose.yml`:

```bash
cd ~/myproject
docker compose up -d
```

To expose it on the web, create `~/supervisor.d/myproject.conf`:

```ini
# hydra.port=3000
# hydra.endpoint=myproject

[program:myproject]
command=docker compose up --abort-on-container-exit
directory=/home/student/myproject
user=student
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/myproject.log
stderr_logfile=/var/log/supervisor/myproject_err.log
environment=HOME="/home/student",USER="student",DOCKER_HOST="unix:///var/run/docker/docker.sock"
```

Then reload and discover:
```bash
sudo supervisorctl reread && sudo supervisorctl update
```

Go to the dashboard > Containers > "Discover Services" to add the route.
Your app will be at: `https://hydra.newpaltz.edu/students/YOUR_USERNAME/myproject/`

### Docker Tips

- **Images persist** between container restarts (stored in the DinD sidecar volume)
- **Ports**: Your Docker containers share the pod network. Bind to `0.0.0.0:PORT` inside your Docker container, then expose that port via the dashboard's Port Routing
- **Compose**: `docker compose` (v2) is installed. Use `docker compose up -d` to run in background
- **Resources**: Docker containers share your pod's CPU/memory limits, so keep it light
- **Cleanup**: Run `docker system prune` periodically to free disk space

## Important Notes

- Files must end with `.conf`
- Use absolute paths for commands
- Set `user=student` to run as the student user
- `autostart=true` means the service starts when the container starts
- `autorestart=true` means the service restarts if it crashes
- Logs are stored in `/var/log/supervisor/`
- Auto-discovery comments (`# hydra.port=` and `# hydra.endpoint=`) are optional but recommended for web services

## Managing Your Services

View all services:
```bash
sudo supervisorctl status
```

Start a service:
```bash
sudo supervisorctl start myapp
```

Stop a service:
```bash
sudo supervisorctl stop myapp
```

Restart a service:
```bash
sudo supervisorctl restart myapp
```

Reload configuration after adding new .conf files:
```bash
sudo supervisorctl reread
sudo supervisorctl update
```

## Exposing Your Service via Dashboard

If your service runs a web server, you can expose it through the dashboard:

### Option 1: Auto-Discovery (Recommended)
1. Add `# hydra.port=PORT` and `# hydra.endpoint=NAME` comments to your .conf file
2. Run `sudo supervisorctl reread && sudo supervisorctl update`
3. Go to the Containers tab in the dashboard
4. Click "Discover Services" in the Port Routing section
5. Click "Add" next to your discovered service

### Option 2: Manual Route
1. Go to the Containers tab in the dashboard
2. Under "Port Routing", add a new route:
   - **Endpoint**: Choose a URL path (e.g., `myapp`)
   - **Port**: The port your service listens on (e.g., `3000`)
3. Access it at: `https://hydra.newpaltz.edu/students/YOUR_USERNAME/myapp/`

## Troubleshooting

**Service won't start?**
- Check logs: `sudo supervisorctl tail myapp stderr`
- Verify the command works manually first
- Make sure all paths are absolute
- Ensure required files/directories exist

**Service crashes repeatedly?**
- Check error logs: `cat /var/log/supervisor/myapp_err.log`
- Test your command manually: `cd /home/student/myapp && node server.js`

**Changes not taking effect?**
- Always run `sudo supervisorctl reread && sudo supervisorctl update` after editing .conf files
- For existing services, restart them: `sudo supervisorctl restart myapp`

**Auto-discovery not finding my service?**
- Make sure the comments are exactly `# hydra.port=NUMBER` and `# hydra.endpoint=NAME`
- Comments must be on their own line
- Endpoint names should be lowercase alphanumeric with hyphens only
- Reload supervisord after adding the comments
