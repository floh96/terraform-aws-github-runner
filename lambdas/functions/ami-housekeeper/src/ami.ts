import {
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeLaunchTemplatesCommand,
  EC2Client,
  Filter,
  Image,
} from '@aws-sdk/client-ec2';
import { DescribeParametersCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createChildLogger } from '@terraform-aws-github-runner/aws-powertools-util';

const logger = createChildLogger('ami');

export interface AmiCleanupOptions {
  minimumDaysOld?: number;
  maxItems?: number;
  filters?: Filter[];
  launchTemplateNames?: string[];
  ssmParameterNames?: string[];
  dryRun?: boolean;
}

interface AmiCleanupOptionsInternal extends AmiCleanupOptions {
  minimumDaysOld: number;
  maxItems: number;
  filters: Filter[];
  launchTemplateNames: string[];
  ssmParameterNames: string[];
}

export const defaultAmiCleanupOptions: AmiCleanupOptions = {
  minimumDaysOld: 30,
  maxItems: undefined,
  filters: [
    {
      Name: 'state',
      Values: ['available'],
    },
    {
      Name: 'image-type',
      Values: ['machine'],
    },
  ],
  launchTemplateNames: undefined,
  ssmParameterNames: undefined,
};

function applyDefaults(options: AmiCleanupOptions): AmiCleanupOptions {
  return {
    minimumDaysOld: options.minimumDaysOld ?? defaultAmiCleanupOptions.minimumDaysOld,
    maxItems: options.maxItems ?? defaultAmiCleanupOptions.maxItems,
    filters: options.filters ?? defaultAmiCleanupOptions.filters,
    launchTemplateNames: options.launchTemplateNames ?? defaultAmiCleanupOptions.launchTemplateNames,
    ssmParameterNames: options.ssmParameterNames ?? defaultAmiCleanupOptions.ssmParameterNames,
  };
}

/**
 * Cleanup AMIs that are not in use anymore.
 *
 * @param options the cleanup options
 */
async function amiCleanup(options: AmiCleanupOptions): Promise<void> {
  const mergedOptions = applyDefaults(options) as AmiCleanupOptionsInternal;
  logger.info(`Cleaning up non used AMIs older then ${mergedOptions.minimumDaysOld} days`);
  logger.debug('Using the following options', { options: mergedOptions });

  const amisNotInUse = await getAmisNotInUse(mergedOptions);

  for (const image of amisNotInUse) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await deleteAmi(image, mergedOptions);
  }
}

async function getAmisNotInUse(options: AmiCleanupOptions) {
  const amiIdsInSSM = await getAmisReferedInSSM(options);
  const amiIdsInTemplates = await getAmiInLatestTemplates(options);

  const ec2Client = new EC2Client({});
  logger.debug('Getting all AMIs from ec2 with filters', { filters: options.filters });
  const amiEc2 = await ec2Client.send(
    new DescribeImagesCommand({
      Owners: ['self'],
      MaxResults: options.maxItems ? options.maxItems : undefined,
      Filters: options.filters,
    }),
  );
  logger.debug('Found the following AMIs', { amiEc2 });

  // sort oldest first
  amiEc2.Images?.sort((a, b) => {
    if (a.CreationDate && b.CreationDate) {
      return new Date(a.CreationDate).getTime() - new Date(b.CreationDate).getTime();
    } else {
      return 0;
    }
  });
  logger.info(`found #${amiEc2.Images?.length} images in ec2`);

  logger.info(`found #${amiIdsInSSM.length} images referenced in SSM`);
  logger.info(`found #${amiIdsInTemplates.length} images in latest versions of launch templates`);
  const filteredAmiEc2 =
    amiEc2.Images?.filter(
      (image) => !amiIdsInSSM.includes(image.ImageId) && !amiIdsInTemplates.includes(image.ImageId),
    ) ?? [];

  logger.info(`found #${filteredAmiEc2.length} images in ec2 not in use.`);

  return filteredAmiEc2;
}

async function deleteAmi(amiDetails: Image, options: AmiCleanupOptionsInternal): Promise<void> {
  // check if ami is older then 30 days
  const creationDate = amiDetails.CreationDate ? new Date(amiDetails.CreationDate) : undefined;
  const minimumDaysOldDate = new Date();
  minimumDaysOldDate.setDate(minimumDaysOldDate.getDate() - options.minimumDaysOld);
  if (!creationDate) {
    logger.warn(`ami ${amiDetails.ImageId} has no creation date`);
    return;
  } else if (creationDate > minimumDaysOldDate) {
    logger.debug(
      `ami ${amiDetails.Name || amiDetails.ImageId} created on ${amiDetails.CreationDate} is not deleted, ` +
        `not older then ${options.minimumDaysOld} days`,
    );
    return;
  }

  try {
    logger.info(`deleting ami ${amiDetails.ImageId} created at ${amiDetails.CreationDate}`);
    const ec2Client = new EC2Client({});
    await ec2Client.send(new DeregisterImageCommand({ ImageId: amiDetails.ImageId }));
    await deleteSnapshot(amiDetails, ec2Client);
  } catch (error) {
    logger.warn(`Cannot delete ami ${amiDetails.ImageId}`);
    logger.debug(`Cannot delete ami ${amiDetails.ImageId}`, { error });
  }
}

async function deleteSnapshot(amiDetails: Image, ec2Client: EC2Client) {
  amiDetails.BlockDeviceMappings?.map(async (blockDeviceMapping) => {
    const snapshotId = blockDeviceMapping.Ebs?.SnapshotId;
    if (snapshotId) {
      try {
        logger.info(`deleting snapshot ${snapshotId} from ami ${amiDetails.ImageId}`);
        await ec2Client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
      } catch (error) {
        logger.error(`Cannot delete snapshot ${snapshotId} for ${amiDetails.ImageId}`);
        logger.debug(`Cannot delete snapshot ${snapshotId} for ${amiDetails.ImageId}`, { error });
      }
    }
  });
}

async function getAmiInLatestTemplates(options: AmiCleanupOptions): Promise<(string | undefined)[]> {
  const ec2Client = new EC2Client({});
  const launnchTemplates = await ec2Client.send(
    new DescribeLaunchTemplatesCommand({
      LaunchTemplateNames: options.launchTemplateNames,
    }),
  );

  // lookup details of latest version of each launch template
  const amiIdsInTemplates = await Promise.all(
    launnchTemplates.LaunchTemplates?.map(async (launchTemplate) => {
      const launchTemplateVersion = await ec2Client.send(
        new DescribeLaunchTemplateVersionsCommand({
          LaunchTemplateId: launchTemplate.LaunchTemplateId,
          Versions: ['$Default'],
        }),
      );
      return launchTemplateVersion.LaunchTemplateVersions?.map(
        (templateVersion) => templateVersion.LaunchTemplateData?.ImageId,
      ).flat();
    }) ?? [],
  );

  return amiIdsInTemplates.flat();
}

async function getAmisReferedInSSM(options: AmiCleanupOptions): Promise<(string | undefined)[]> {
  if (!options.ssmParameterNames || options.ssmParameterNames.length === 0) {
    return [];
  }

  const ssmClient = new SSMClient({});
  const ssmParams = await ssmClient.send(
    new DescribeParametersCommand({
      ParameterFilters: [
        {
          Key: 'Name',
          Values: ['ami-id'],
          Option: 'Contains',
        },
      ],
    }),
  );
  logger.debug('Found the following SSM parameters', { ssmParams });

  return await Promise.all(
    (ssmParams.Parameters ?? []).map(async (param) => {
      const paramValue = await ssmClient.send(
        new GetParameterCommand({
          Name: param.Name,
        }),
      );
      return paramValue.Parameter?.Value;
    }),
  );
}

export { amiCleanup, getAmisNotInUse };
