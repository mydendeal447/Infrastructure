terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
  required_version = ">= 1.2.0"
}

provider "azurerm" {
  features {}
}

# Resource Group
resource "azurerm_resource_group" "rg" {
  name     = "${var.project_name}-${var.environment}-rg"
  location = var.location
  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

# Virtual Network
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.project_name}-vnet"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  address_space       = [var.address_space]
}

# Subnets
resource "azurerm_subnet" "app_subnet" {
  name                 = "app-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_prefixes["app_subnet"]]
}

resource "azurerm_subnet" "data_subnet" {
  name                 = "data-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_prefixes["data_subnet"]]
}

resource "azurerm_subnet" "frontend_subnet" {
  name                 = "frontend-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_prefixes["frontend_subnet"]]
}

# Application Security Group
resource "azurerm_application_security_group" "asg" {
  name                = "${var.project_name}-asg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

# Network Security Group
resource "azurerm_network_security_group" "nsg" {
  name                = "${var.project_name}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  security_rule {
    name                       = "allow-https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range         = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# App Service Plan
resource "azurerm_service_plan" "app_plan" {
  name                = "${var.project_name}-app-plan"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  os_type            = "Linux"
  sku_name           = "${var.sku_tier}_${var.sku_size}"
}

# App Service for AR/VR Frontend
resource "azurerm_linux_web_app" "frontend" {
  name                = "${var.project_name}-frontend"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  service_plan_id     = azurerm_service_plan.app_plan.id

  site_config {
    application_stack {
      node_version = "18-lts"
    }
  }
}

# Azure Container Registry
resource "azurerm_container_registry" "acr" {
  name                = replace("${var.project_name}acr", "-", "")
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                = "Premium"
  admin_enabled      = true
}

# Azure Cosmos DB for product catalog and user data
resource "azurerm_cosmosdb_account" "db" {
  name                = "${var.project_name}-cosmos"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  offer_type         = "Standard"
  kind               = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }
}

# Azure Storage Account for AR/VR assets
resource "azurerm_storage_account" "storage" {
  name                     = replace("${var.project_name}storage", "-", "")
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier            = "Standard"
  account_replication_type = "GRS"
  account_kind            = "StorageV2"
  enable_https_traffic_only = true

  static_website {
    index_document = "index.html"
  }
}

# Azure CDN Profile for AR/VR content delivery
resource "azurerm_cdn_profile" "cdn" {
  name                = "${var.project_name}-cdn"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                = "Standard_Microsoft"
}

# Azure CDN Endpoint
resource "azurerm_cdn_endpoint" "cdn_endpoint" {
  name                = "${var.project_name}-cdn-endpoint"
  profile_name        = azurerm_cdn_profile.cdn.name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  origin {
    name       = "primary"
    host_name  = azurerm_storage_account.storage.primary_web_host
  }
}

# Application Insights for monitoring
resource "azurerm_application_insights" "appinsights" {
  name                = "${var.project_name}-appinsights"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  application_type    = "web"
} 