import { DefaultAzureCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import { NetworkManagementClient } from "@azure/arm-network";
import { ContainerServiceClient } from "@azure/arm-containerservice";
import { FlexibleServers } from "@azure/arm-postgresql-flexible";
import { StorageManagementClient } from "@azure/arm-storage";
import { CdnManagementClient } from "@azure/arm-cdn";
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['AZURE_SUBSCRIPTION_ID', 'DB_PASSWORD'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please set these variables in your environment or .env file');
  process.exit(1);
}

// Configuration with environment variable fallbacks
const config = {
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
  resourceGroupName: process.env.RESOURCE_GROUP_NAME || "ar-vr-ecommerce-rg",
  location: process.env.LOCATION || "eastus",
  vnetName: "ar-vr-ecommerce-vnet",
  vnetAddressSpace: "10.0.0.0/16",
  appSubnetName: "app-subnet",
  appSubnetPrefix: "10.0.1.0/24",
  dbSubnetName: "db-subnet",
  dbSubnetPrefix: "10.0.2.0/24",
  aksName: "ar-vr-ecommerce-aks",
  dbName: "ar-vr-ecommerce-db",
  dbUsername: process.env.DB_USERNAME || "adminuser",
  dbPassword: process.env.DB_PASSWORD!,
  storageAccountName: process.env.STORAGE_ACCOUNT_NAME || "arvrecommerceassets",
  cdnProfileName: "arvrecommercecdn",
  cdnEndpointName: "arvrecommerceendpoint"
};

// Custom error class for infrastructure errors
class InfrastructureError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'InfrastructureError';
  }
}

// Retry configuration
const retryConfig = {
  maxRetries: 3,
  retryDelay: 5000, // 5 seconds
};

// Utility function for retrying operations
async function retry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = retryConfig.maxRetries
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.warn(`Attempt ${attempt}/${maxRetries} failed for ${operationName}:`, error);
      
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryConfig.retryDelay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelay));
      }
    }
  }
  
  throw new InfrastructureError(
    `Operation ${operationName} failed after ${maxRetries} attempts`,
    lastError
  );
}

class AzureInfrastructure {
  private credential: DefaultAzureCredential;
  private resourceClient: ResourceManagementClient;
  private networkClient: NetworkManagementClient;
  private aksClient: ContainerServiceClient;
  private postgresClient: FlexibleServers;
  private storageClient: StorageManagementClient;
  private cdnClient: CdnManagementClient;

  constructor() {
    try {
      this.credential = new DefaultAzureCredential();
      this.resourceClient = new ResourceManagementClient(this.credential, config.subscriptionId);
      this.networkClient = new NetworkManagementClient(this.credential, config.subscriptionId);
      this.aksClient = new ContainerServiceClient(this.credential, config.subscriptionId);
      this.postgresClient = new FlexibleServers(this.credential, config.subscriptionId);
      this.storageClient = new StorageManagementClient(this.credential, config.subscriptionId);
      this.cdnClient = new CdnManagementClient(this.credential, config.subscriptionId);
    } catch (error) {
      throw new InfrastructureError('Failed to initialize Azure clients', error as Error);
    }
  }

  private async validateAzureConnection() {
    try {
      // Validate connection by getting subscription details
      await this.resourceClient.subscriptions.get(config.subscriptionId);
      console.log('Successfully connected to Azure');
    } catch (error) {
      throw new InfrastructureError('Failed to connect to Azure. Please check your credentials.', error as Error);
    }
  }

  async createResourceGroup() {
    console.log(`Creating resource group: ${config.resourceGroupName}`);
    try {
      await retry(
        () => this.resourceClient.resourceGroups.createOrUpdate(config.resourceGroupName, {
          location: config.location,
        }),
        'Create Resource Group'
      );
      console.log(`Resource group '${config.resourceGroupName}' created successfully.`);
    } catch (error) {
      throw new InfrastructureError(`Failed to create resource group: ${config.resourceGroupName}`, error as Error);
    }
  }

  async createVirtualNetwork() {
    console.log(`Creating virtual network: ${config.vnetName}`);
    try {
      await retry(
        async () => {
          const vnet = await this.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(
            config.resourceGroupName,
            config.vnetName,
            {
              location: config.location,
              addressSpace: {
                addressPrefixes: [config.vnetAddressSpace],
              },
            }
          );
          console.log(`Virtual network '${config.vnetName}' created.`);

          // Create subnets
          console.log("Creating subnets...");
          await Promise.all([
            this.networkClient.subnets.beginCreateOrUpdateAndWait(
              config.resourceGroupName,
              config.vnetName,
              config.appSubnetName,
              {
                addressPrefix: config.appSubnetPrefix,
              }
            ),
            this.networkClient.subnets.beginCreateOrUpdateAndWait(
              config.resourceGroupName,
              config.vnetName,
              config.dbSubnetName,
              {
                addressPrefix: config.dbSubnetPrefix,
              }
            )
          ]);
          console.log("Subnets created successfully.");
        },
        'Create Virtual Network and Subnets'
      );
    } catch (error) {
      throw new InfrastructureError(`Failed to create virtual network: ${config.vnetName}`, error as Error);
    }
  }

  async createAKSCluster() {
    console.log(`Creating AKS cluster: ${config.aksName}`);
    try {
      await retry(
        () => this.aksClient.managedClusters.beginCreateOrUpdateAndWait(
          config.resourceGroupName,
          config.aksName,
          {
            location: config.location,
            dnsPrefix: "arvrecommerce",
            agentPoolProfiles: [
              {
                name: "default",
                count: 2,
                vmSize: "Standard_DS2_v2",
                mode: "System",
                osType: "Linux",
              },
            ],
            identity: {
              type: "SystemAssigned",
            },
          }
        ),
        'Create AKS Cluster'
      );
      console.log(`AKS cluster '${config.aksName}' created successfully.`);
    } catch (error) {
      throw new InfrastructureError(`Failed to create AKS cluster: ${config.aksName}`, error as Error);
    }
  }

  async createPostgreSQLServer() {
    console.log(`Creating PostgreSQL server: ${config.dbName}`);
    try {
      await retry(
        () => this.postgresClient.servers.beginCreateAndWait(
          config.resourceGroupName,
          config.dbName,
          {
            location: config.location,
            sku: {
              name: "Standard_D2ds_v4",
              tier: "GeneralPurpose",
            },
            administratorLogin: config.dbUsername,
            administratorLoginPassword: config.dbPassword,
            version: "13",
            storage: {
              storageSizeGB: 32,
            },
          }
        ),
        'Create PostgreSQL Server'
      );
      console.log(`PostgreSQL server '${config.dbName}' created successfully.`);
    } catch (error) {
      throw new InfrastructureError(`Failed to create PostgreSQL server: ${config.dbName}`, error as Error);
    }
  }

  async createStorageAccount() {
    console.log(`Creating storage account: ${config.storageAccountName}`);
    try {
      await retry(
        async () => {
          const storageAccount = await this.storageClient.storageAccounts.beginCreateAndWait(
            config.resourceGroupName,
            config.storageAccountName,
            {
              location: config.location,
              sku: {
                name: "Standard_LRS",
              },
              kind: "StorageV2",
              enableHttpsTrafficOnly: true,
            }
          );
          console.log(`Storage account '${config.storageAccountName}' created.`);

          // Create container
          await this.storageClient.blobContainers.create(
            config.resourceGroupName,
            config.storageAccountName,
            "assets",
            {
              publicAccess: "None",
            }
          );
          console.log("Storage container 'assets' created successfully.");
        },
        'Create Storage Account and Container'
      );
    } catch (error) {
      throw new InfrastructureError(`Failed to create storage account: ${config.storageAccountName}`, error as Error);
    }
  }

  async createCDN() {
    console.log(`Creating CDN profile: ${config.cdnProfileName}`);
    try {
      await retry(
        async () => {
          const cdnProfile = await this.cdnClient.profiles.beginCreateAndWait(
            config.resourceGroupName,
            config.cdnProfileName,
            {
              location: config.location,
              sku: {
                name: "Standard_Microsoft",
              },
            }
          );
          console.log(`CDN profile '${config.cdnProfileName}' created.`);

          const cdnEndpoint = await this.cdnClient.endpoints.beginCreateAndWait(
            config.resourceGroupName,
            config.cdnProfileName,
            config.cdnEndpointName,
            {
              location: config.location,
              origins: [
                {
                  name: "storageorigin",
                  hostName: `${config.storageAccountName}.blob.core.windows.net`,
                },
              ],
              isHttpAllowed: false,
              isHttpsAllowed: true,
            }
          );
          console.log(`CDN endpoint '${config.cdnEndpointName}' created successfully.`);
        },
        'Create CDN Profile and Endpoint'
      );
    } catch (error) {
      throw new InfrastructureError(`Failed to create CDN: ${config.cdnProfileName}`, error as Error);
    }
  }

  async deploy() {
    try {
      console.log('Starting infrastructure deployment...');
      console.log('Validating Azure connection...');
      await this.validateAzureConnection();

      console.log('\nDeployment steps:');
      console.log('1. Creating Resource Group');
      await this.createResourceGroup();

      console.log('\n2. Creating Virtual Network');
      await this.createVirtualNetwork();

      console.log('\n3. Creating AKS Cluster');
      await this.createAKSCluster();

      console.log('\n4. Creating PostgreSQL Server');
      await this.createPostgreSQLServer();

      console.log('\n5. Creating Storage Account');
      await this.createStorageAccount();

      console.log('\n6. Creating CDN');
      await this.createCDN();

      console.log('\nInfrastructure deployment completed successfully! 🎉');
    } catch (error) {
      console.error('\n❌ Deployment failed:', error);
      if (error instanceof InfrastructureError && error.cause) {
        console.error('Caused by:', error.cause);
      }
      process.exit(1);
    }
  }
}

// Run the deployment
console.log('AR/VR E-commerce Infrastructure Deployment');
console.log('=========================================');
const infrastructure = new AzureInfrastructure();
infrastructure.deploy().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 