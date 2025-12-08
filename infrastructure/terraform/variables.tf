# Proxmox Connection
variable "proxmox_api_url" {
  description = "Proxmox API URL (e.g., https://proxmox.example.com:8006/api2/json)"
  type        = string
}

variable "proxmox_api_token_id" {
  description = "Proxmox API token ID (e.g., user@pam!terraform)"
  type        = string
}

variable "proxmox_api_token_secret" {
  description = "Proxmox API token secret"
  type        = string
  sensitive   = true
}

variable "proxmox_tls_insecure" {
  description = "Skip TLS verification (for self-signed certs)"
  type        = bool
  default     = true
}

variable "proxmox_target_node" {
  description = "Proxmox node to create VMs on"
  type        = string
  default     = "pve"
}

# VM Template
variable "ubuntu_template" {
  description = "Name of the Ubuntu template to clone"
  type        = string
  default     = "ubuntu-22.04-template"
}

# Storage
variable "storage_pool" {
  description = "Proxmox storage pool for VM disks"
  type        = string
  default     = "local-lvm"
}

# Networking
variable "network_bridge" {
  description = "Proxmox network bridge"
  type        = string
  default     = "vmbr0"
}

variable "network_prefix" {
  description = "Network prefix for static IPs (e.g., 10.0.0)"
  type        = string
  default     = "10.0.0"
}

variable "network_gateway" {
  description = "Network gateway IP"
  type        = string
  default     = "10.0.0.1"
}

variable "nameserver" {
  description = "DNS nameserver"
  type        = string
  default     = "8.8.8.8"
}

# SSH Access
variable "ssh_public_keys" {
  description = "SSH public keys for infra user (newline separated)"
  type        = string
}

# GPU Passthrough
variable "chimera_gpu_ids" {
  description = "PCI IDs for Chimera GPUs (e.g., ['0000:01:00.0', '0000:02:00.0'])"
  type        = list(string)
  default     = []
}

variable "cerberus_gpu_ids" {
  description = "PCI IDs for Cerberus GPUs"
  type        = list(string)
  default     = []
}
