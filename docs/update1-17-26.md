# Hydra Server Cleanup - January 17, 2026

## Summary
Server cleanup performed to remove unused accounts, databases, snap packages, and services. RAID-10 array configured for RKE2 cluster storage.

---

## BACKUPS

### Primary Backup - Chimera Server
**Server**: Chimera (192.168.1.150)
**Storage**:
- Samsung NVMe 3.5TB (nvme0n1) - OS drive, stores /opt/Backups (1.6TB used, 1.7TB available)
- Micron 5210 SSD 3.5TB (sda) - additional storage

**Location**: `/opt/Backups/home`
**Schedule**: Daily at 2:00 AM via rsync
**Contents**: 70 home directories from Hydra (includes all deleted users' data)

**To access**:
```bash
ssh infra@192.168.1.150
ls -la /opt/Backups/home
```

**Cron job** (on Hydra):
```
0 2 * * * rsync -aAxv /./home chimera:/opt/Backups
```

### Local Backup - Hydra (Seagate ST1200MM0099)
**Server**: Hydra (local)
**Storage**: Seagate ST1200MM0099 (1.1TB) - /dev/sdh
**Partitions**: /mnt/sdh3 (47GB), /mnt/sdh4 (1TB)

| Mount | Contents | Date |
|-------|----------|------|
| /mnt/sdh3 | Full system backup (bin, boot, etc, home, etc.) | Aug 2023 |
| /mnt/sdh4 | Home directory backup (kaitlin only) | Aug 2023 |

**To access**:
```bash
ls -la /mnt/sdh3/home/
ls -la /mnt/sdh4/
```

### Temporary Cleanup Backups
**Location**: `/tmp/claude/-home-infra/d7c271a1-a50b-47eb-9dfd-c1989c12e920/scratchpad/`

**Contents**:
- `db_backups/` - MySQL database dumps (kk_db, kontol_db, louristeo_db, molly2_db, slaterm2_db, test123_db)
- `users_backup.txt` - Original /etc/passwd entries

**WARNING**: These are in /tmp and will be lost on reboot. To preserve:
```bash
sudo cp -r /tmp/claude/-home-infra/d7c271a1-a50b-47eb-9dfd-c1989c12e920/scratchpad /home/infra/cleanup_backups_2026-01-17
```

---

## CURRENT STATE

### Users (5 remaining)
| User | Home Directory | SSH Keys |
|------|---------------|----------|
| infra | /home/infra | 3 keys |
| kaitlin | /home/kaitlin | None |
| easwaran | /home/easwaran | None |
| ashley | /home/ashley | None |
| hoffmank4 | /home/hoffmank4 | None |

### MySQL Databases (6 remaining)
| Database | Purpose |
|----------|---------|
| hydraLab | Main application database |
| kaitlin | User database (kept) |
| mysql | System |
| information_schema | System |
| performance_schema | System |
| sys | System |

### Storage Configuration
| Mount | Device | Size | Available |
|-------|--------|------|-----------|
| / | ubuntu-vg/ubuntu-lv | 1TB | 874GB |
| /data | /dev/md0 (RAID-10) | 21TB | 20TB |
| /boot/efi | /dev/sdg1 | 1GB | - |
| /boot | /dev/sdg2 | 2GB | - |
| /mnt/sdh3 | /dev/sdh3 | 47GB | - |
| /mnt/sdh4 | /dev/sdh4 | 1TB | - |

### RAID-10 Array Details
```
Device: /dev/md0
Level: RAID-10 (mirrored stripes)
Drives: sda, sdb, sdc, sdd, sde, sdf (6x 7TB Samsung)
Usable Space: ~21TB
Mount Point: /data
Filesystem: ext4
```

### Active Services
- Apache2
- MariaDB
- PostgreSQL
- PM2 (cs-lab-backend)
- hydra-backend.service
- Docker (21 containers)
- SSH, Fail2Ban, ClamAV
- Samba

### Directory Ownership (changed to infra:infra)
- `/srv/dockerstuff`
- `/srv/metrics-compose`

---

## WHAT WAS REMOVED

### Users Deleted (25)
```
rodolfo, harsh, anjali, taylor, chris, surrya, mikem, nathan, maddie,
mostafa, col, kk, demilion1, persichd1, rivasd8, rivas8, alejilal1,
slaterm2, mathewj10, hydra, stivi, louristeo, molly2, kontol, test123
```
- Home directories: DELETED
- Crontabs: DELETED
- Running processes: KILLED

### MySQL Databases Deleted (6)
```
kk_db, kontol_db, louristeo_db, molly2_db, slaterm2_db, test123_db
```
(Backups saved before deletion - see Temporary Cleanup Backups above)

### Snap Packages Removed
| Package | Replacement |
|---------|-------------|
| aws-cli | None (use pip if needed) |
| certbot | apt certbot v1.21.0 |
| postgresql10 | postgresql-14 (native) |
| lxd | None |
| snapd + cores | Completely purged |

**Directories removed**: `/snap`, `/var/snap`, `/var/lib/snapd`

### Services Disabled
| Service | Reason |
|---------|--------|
| cloud-init, cloud-init-local, cloud-config, cloud-final | Not a cloud VM |
| ModemManager | No modem hardware |
| wpa_supplicant | No WiFi hardware |
| lxd.service, lxd.socket | LXD removed |

---

## NOT COMPLETED

| Item | Reason |
|------|--------|
| SSH key-only authentication | Skipped - kaitlin, easwaran, ashley, hoffmank4 have no SSH keys configured |

---

## POST-CLEANUP VERIFICATION

All checks passed:
- `docker ps` - 21 containers running
- `systemctl status apache2 mariadb postgresql hydra-backend` - All active
- `curl https://hydra.newpaltz.edu` - HTTP 200 OK
- `cat /etc/passwd | grep /home/ | wc -l` - 5 users
- `df -h /data` - 21TB mounted at /data
- `cat /proc/mdstat` - RAID-10 syncing (will complete in ~28 hours)

---

## RECOMMENDED NEXT STEPS

1. **Preserve temporary backups** before reboot:
   ```bash
   sudo cp -r /tmp/claude/-home-infra/d7c271a1-a50b-47eb-9dfd-c1989c12e920/scratchpad /home/infra/cleanup_backups_2026-01-17
   ```

2. **Configure SSH keys** for kaitlin, easwaran, ashley, hoffmank4 before enabling key-only auth

3. **Reboot server** to verify all changes persist

4. **Monitor RAID sync**:
   ```bash
   watch cat /proc/mdstat
   ```

5. **Fix Caddy repo GPG key** (expired key warning observed):
   ```bash
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   ```
