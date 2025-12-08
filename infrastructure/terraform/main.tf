# Hydra Cluster - Proxmox VM Provisioning
# This Terraform configuration provisions VMs on a Proxmox host
# After provisioning, use Ansible playbooks to configure the VMs

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    proxmox = {
      source  = "Telmate/proxmox"
      version = "~> 3.0"
    }
  }
}

provider "proxmox" {
  pm_api_url          = var.proxmox_api_url
  pm_api_token_id     = var.proxmox_api_token_id
  pm_api_token_secret = var.proxmox_api_token_secret
  pm_tls_insecure     = var.proxmox_tls_insecure
}

# Local variables for node configuration
locals {
  nodes = {
    hydra = {
      target_node = var.proxmox_target_node
      cores       = 8
      memory      = 32768
      disk_size   = "100G"
      ip          = "${var.network_prefix}.10"
      gateway     = var.network_gateway
      tags        = ["control", "docker"]
      gpu         = false
    }
    chimera = {
      target_node = var.proxmox_target_node
      cores       = 16
      memory      = 65536
      disk_size   = "500G"
      ip          = "${var.network_prefix}.11"
      gateway     = var.network_gateway
      tags        = ["gpu", "inference"]
      gpu         = true
      gpu_ids     = var.chimera_gpu_ids
    }
    cerberus = {
      target_node = var.proxmox_target_node
      cores       = 16
      memory      = 65536
      disk_size   = "1T"
      ip          = "${var.network_prefix}.12"
      gateway     = var.network_gateway
      tags        = ["gpu", "training"]
      gpu         = true
      gpu_ids     = var.cerberus_gpu_ids
    }
  }
}

# Create VMs using the module
module "hydra_nodes" {
  source   = "./modules/proxmox-vm"
  for_each = local.nodes

  vm_name       = each.key
  target_node   = each.value.target_node
  clone_template = var.ubuntu_template
  cores         = each.value.cores
  memory        = each.value.memory
  disk_size     = each.value.disk_size
  storage       = var.storage_pool
  network_bridge = var.network_bridge
  ip_address    = each.value.ip
  gateway       = each.value.gateway
  nameserver    = var.nameserver
  ssh_keys      = var.ssh_public_keys
  tags          = each.value.tags
  gpu_passthrough = each.value.gpu
  gpu_ids       = lookup(each.value, "gpu_ids", [])
}

# Output the generated Ansible inventory
output "ansible_inventory" {
  value = templatefile("${path.module}/templates/inventory.tftpl", {
    hydra_ip    = module.hydra_nodes["hydra"].ip_address
    chimera_ip  = module.hydra_nodes["chimera"].ip_address
    cerberus_ip = module.hydra_nodes["cerberus"].ip_address
  })
  description = "Generated Ansible inventory file content"
}

output "node_ips" {
  value = {
    hydra    = module.hydra_nodes["hydra"].ip_address
    chimera  = module.hydra_nodes["chimera"].ip_address
    cerberus = module.hydra_nodes["cerberus"].ip_address
  }
  description = "IP addresses of provisioned nodes"
}
