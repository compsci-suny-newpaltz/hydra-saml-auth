variable "vm_name" {
  description = "Name of the VM"
  type        = string
}

variable "target_node" {
  description = "Proxmox node to create VM on"
  type        = string
}

variable "clone_template" {
  description = "Template to clone from"
  type        = string
}

variable "cores" {
  description = "Number of CPU cores"
  type        = number
  default     = 4
}

variable "memory" {
  description = "Memory in MB"
  type        = number
  default     = 8192
}

variable "disk_size" {
  description = "Boot disk size"
  type        = string
  default     = "50G"
}

variable "storage" {
  description = "Storage pool"
  type        = string
  default     = "local-lvm"
}

variable "network_bridge" {
  description = "Network bridge"
  type        = string
  default     = "vmbr0"
}

variable "ip_address" {
  description = "Static IP address"
  type        = string
}

variable "gateway" {
  description = "Network gateway"
  type        = string
}

variable "nameserver" {
  description = "DNS nameserver"
  type        = string
  default     = "8.8.8.8"
}

variable "ssh_keys" {
  description = "SSH public keys"
  type        = string
}

variable "ci_password" {
  description = "Cloud-init password for infra user"
  type        = string
  default     = ""
  sensitive   = true
}

variable "tags" {
  description = "VM tags"
  type        = list(string)
  default     = []
}

variable "gpu_passthrough" {
  description = "Enable GPU passthrough"
  type        = bool
  default     = false
}

variable "gpu_ids" {
  description = "PCI IDs for GPU passthrough"
  type        = list(string)
  default     = []
}
