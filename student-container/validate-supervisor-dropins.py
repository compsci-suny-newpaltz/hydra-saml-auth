#!/usr/bin/env python3
"""
validate-supervisor-dropins — quarantine broken ~/supervisor.d/*.conf files
BEFORE supervisord starts.

Why: supervisord is PID 1 in the student container and it aborts completely
(no sshd, no code-server, no port routes) if ANY file it [include]s fails to
parse.  The classic case is `user=postgres` in a drop-in after the postgres
Linux account vanished on a pod restart (only /home/student persists).  The
dashboard still shows the pod as Running, so the student just loses access.

What this does: runs supervisord's own config parser on each drop-in, one at a
time, against the real main config.  A drop-in that would make supervisord die
is renamed to <name>.conf.broken and a BROKEN-<name>.txt note explaining the
error and how to fix it is left next to it.  Good drop-ins are untouched.

Exit status is always 0 unless the validator itself crashes; the entrypoint
starts supervisord regardless.
"""
import glob
import os
import pwd
import re
import shutil
import sys
import time

MAIN_CONF = '/etc/supervisor/conf.d/supervisord.conf'
DROPIN_DIR = '/home/student/supervisor.d'
LOG = '/var/log/supervisor/dropin-validation.log'
try:
    _pw = pwd.getpwnam('student')
    STUDENT_UID, STUDENT_GID = _pw.pw_uid, _pw.pw_gid
except KeyError:
    STUDENT_UID, STUDENT_GID = 1000, 1000
SCRATCH = '/run/supervisor-validate'


def log(msg):
    line = f'[dropin-validate] {msg}'
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a') as fh:
            fh.write(time.strftime('%Y-%m-%d %H:%M:%S ') + line + '\n')
    except OSError:
        pass


def parse_error(include_glob):
    """Return None if supervisord would accept MAIN_CONF with its [include]
    pointed at `include_glob`, otherwise the parser's error message."""
    from supervisor.options import ServerOptions

    text = open(MAIN_CONF).read()
    text = re.sub(r'\[include\][^\[]*', f'[include]\nfiles = {include_glob}\n', text)
    tmp = os.path.join(os.path.dirname(MAIN_CONF), '.validate.conf')  # same dir => same %(here)s
    with open(tmp, 'w') as fh:
        fh.write(text)
    try:
        opts = ServerOptions()
        opts.configfile = tmp
        opts.process_config(do_usage=False)
        return None
    except ValueError as e:
        return str(e)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def quarantine(path, error, why):
    name = os.path.basename(path)
    stem = name[:-len('.conf')]
    dest = path + '.broken'
    if os.path.exists(dest):
        dest = f'{dest}.{int(time.time())}'
    os.rename(path, dest)
    note = os.path.join(DROPIN_DIR, f'BROKEN-{stem}.txt')
    with open(note, 'w') as fh:
        fh.write(f"""Your supervisor drop-in "{name}" was DISABLED on container start ({time.strftime('%Y-%m-%d %H:%M')}).

It was renamed to:  {os.path.basename(dest)}
Nothing else was touched.

Reason: {why}

Parser error:
  {error}

If supervisord had loaded this file it would have refused to start AT ALL,
taking SSH, the web terminal/VS Code and all of your port routes down with it.
So the file was set aside and the rest of your container started normally.

How to fix it:
  1. Edit {os.path.basename(dest)} and correct the problem above.
     Common causes:
       - user=<name> refers to a Linux user that does not exist.  Only files under
         /home/student survive a restart; users/packages added with apt or
         useradd are gone the next time the container starts.  Use user=student.
       - a typo or missing [program:...] / command= line.
  2. Rename it back:   mv {os.path.basename(dest)} {name}
  3. Reload:           sudo supervisorctl reread && sudo supervisorctl update
  4. Delete this note.

See ~/supervisor.d/README.md ("What persists across restarts").
""")
    for p in (dest, note):
        try:
            os.chown(p, STUDENT_UID, STUDENT_GID)
        except OSError:
            pass
    log(f'DISABLED {name} -> {os.path.basename(dest)}: {error}')


def main():
    if not os.path.isdir(DROPIN_DIR):
        return 0
    files = sorted(glob.glob(os.path.join(DROPIN_DIR, '*.conf')))
    if not files:
        return 0

    # Pass 1: each drop-in alone (copied under a safe name so odd filenames can't break the glob).
    shutil.rmtree(SCRATCH, ignore_errors=True)
    os.makedirs(SCRATCH)
    bad = 0
    for path in files:
        probe = os.path.join(SCRATCH, 'probe.conf')
        shutil.copyfile(path, probe)
        err = parse_error(os.path.join(SCRATCH, '*.conf'))
        os.unlink(probe)
        if err:
            quarantine(path, err.replace(probe, path),
                       'supervisord cannot parse this file (see parser error).')
            bad += 1
    shutil.rmtree(SCRATCH, ignore_errors=True)

    # Pass 2: everything that survived, together, exactly as supervisord will load it.
    err = parse_error(os.path.join(DROPIN_DIR, '*.conf'))
    if err:
        for path in sorted(glob.glob(os.path.join(DROPIN_DIR, '*.conf'))):
            quarantine(path, err, 'the drop-ins conflict with each other or with the built-in '
                                  'services when loaded together, so all were set aside.')
            bad += 1

    good = len(files) - bad
    log(f'{good} drop-in(s) OK, {bad} disabled')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # never block container start because the validator itself broke
        log(f'validator error (ignored): {e!r}')
        sys.exit(0)
