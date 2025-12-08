# Proxmox VM Module
# Creates a VM from a template with optional GPU passthrough

terraform {
  required_providers {
    proxmox = {
      source  = "Telmate/proxmox"
      version = "~> 3.0"
    }
  }
}

resource "proxmox_vm_qemu" "vm" {
  name        = var.vm_name
  target_node = var.target_node
  clone       = var.clone_template
  full_clone  = true

  # VM Resources
  cores   = var.cores
  sockets = 1
  memory  = var.memory
  cpu     = "host"

  # BIOS/Machine type for GPU passthrough
  bios    = var.gpu_passthrough ? "ovmf" : "seabios"
  machine = var.gpu_passthrough ? "q35" : ""

  # Boot disk
  disks {
    scsi {
      scsi0 {
        disk {
          size    = var.disk_size
          storage = var.storage
          format  = "raw"
        }
      }
    }
  }

  # Network
  network {
    model  = "virtio"
    bridge = var.network_bridge
  }

  # Cloud-init configuration
  os_type    = "cloud-init"
  ciuser     = "infra"
  cipassword = var.ci_password
  sshkeys    = var.ssh_keys
  ipconfig0  = "ip=${var.ip_address}/24,gw=${var.gateway}"
  nameserver = var.nameserver

  # GPU Passthrough (if enabled)
  dynamic "hostpci" {
    for_each = var.gpu_passthrough ? var.gpu_ids : []
    content {
      host   = hostpci.value
      pcie   = true
      rombar = true
    }
  }

  # Agent
  agent = 1

  # Lifecycle
  lifecycle {
    ignore_changes = [
      network,
    ]
  }

  # Tags
  tags = join(",", var.tags)
}

output "ip_address" {
  value = var.ip_address
}

output "vm_id" {
  value = proxmox_vm_qemu.vm.id
}
