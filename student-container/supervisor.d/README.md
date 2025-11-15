# Custom Supervisord Services

This directory is for adding your own custom services that will run automatically in your container.

## How to Add a Custom Service

1. Create a `.conf` file in this directory (e.g., `myapp.conf`)
2. Restart your container or reload supervisord: `sudo supervisorctl reread && sudo supervisorctl update`

## Example: Web Application

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

## Important Notes

- Files must end with `.conf`
- Use absolute paths for commands
- Set `user=student` to run as the student user
- `autostart=true` means the service starts when the container starts
- `autorestart=true` means the service restarts if it crashes
- Logs are stored in `/var/log/supervisor/`

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
