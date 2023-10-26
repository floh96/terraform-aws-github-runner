import {
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeLaunchTemplatesCommand,
  EC2Client,
  Image,
} from '@aws-sdk/client-ec2';
import {
  DescribeParametersCommand,
  DescribeParametersCommandOutput,
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { amiCleanup } from './ami';

process.env.AWS_REGION = 'eu-east-1';
const deleteAmisOlderThenDays = 30;
const date31DaysAgo = new Date(new Date().setDate(new Date().getDate() - (deleteAmisOlderThenDays + 1)));

const mockEC2Client = mockClient(EC2Client);
const mockSSMClient = mockClient(SSMClient);

const imagesInUse: Image[] = [
  {
    ImageId: 'ami-ssm0001',
    CreationDate: date31DaysAgo.toISOString(),
  },
  {
    ImageId: 'ami-ssm0002',
  },
  {
    ImageId: 'ami-lt0001',
    CreationDate: date31DaysAgo.toISOString(),
  },
];

const ssmParameters: DescribeParametersCommandOutput = {
  Parameters: [
    {
      Name: 'ami-ssm0001',
      Type: 'String',
      Version: 1,
    },
    {
      Name: 'ami-ssm0002',
      Type: 'String',
      Version: 1,
    },
  ],
  $metadata: {
    httpStatusCode: 200,
    requestId: '1234',
    extendedRequestId: '1234',
    cfId: undefined,
    attempts: 1,
    totalRetryDelay: 0,
  },
};

describe("delete AMI's", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockEC2Client.reset();
    mockSSMClient.reset();

    mockSSMClient.on(DescribeParametersCommand).resolves(ssmParameters);
    mockSSMClient.on(GetParameterCommand, { Name: 'ami-ssm0001' }).resolves({
      Parameter: {
        Name: 'ami-ssm0001',
        Type: 'String',
        Value: 'ami-ssm0001',
        Version: 1,
      },
    });
    mockSSMClient.on(GetParameterCommand, { Name: 'ami-ssm0002' }).resolves({
      Parameter: {
        Name: 'ami-ssm0002',
        Type: 'String',
        Value: 'ami-ssm0002',
        Version: 1,
      },
    });

    mockEC2Client.on(DescribeLaunchTemplatesCommand).resolves({
      LaunchTemplates: [
        {
          LaunchTemplateId: 'lt-1234',
          LaunchTemplateName: 'lt-1234',
          DefaultVersionNumber: 1,
          LatestVersionNumber: 2,
        },
      ],
    });

    mockEC2Client
      .on(DescribeLaunchTemplateVersionsCommand, {
        LaunchTemplateId: 'lt-1234',
      })
      .resolves({
        LaunchTemplateVersions: [
          {
            LaunchTemplateId: 'lt-1234',
            LaunchTemplateName: 'lt-1234',
            VersionNumber: 2,
            LaunchTemplateData: {
              ImageId: 'ami-lt0001',
            },
          },
        ],
      });
  });

  mockEC2Client.on(DeregisterImageCommand).resolves({});
  mockEC2Client.on(DeleteSnapshotCommand).resolves({});

  it('should NOT delete instances in use.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [...imagesInUse],
    });

    await amiCleanup();
    expect(mockEC2Client).not.toHaveReceivedCommand(DeregisterImageCommand);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });

  it('should not call delete when no AMIs at all.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: undefined,
    });
    mockSSMClient.on(DescribeParametersCommand).resolves({
      Parameters: undefined,
    });
    mockEC2Client.on(DescribeLaunchTemplatesCommand).resolves({
      LaunchTemplates: undefined,
    });

    await amiCleanup({
      minimumDaysOld: deleteAmisOlderThenDays,
    });
    expect(mockEC2Client).not.toHaveReceivedCommand(DeregisterImageCommand);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });

  it('should filter delete AMIs not in use older then 30 days.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [
        ...imagesInUse,
        {
          ImageId: 'ami-old0001',
          CreationDate: date31DaysAgo.toISOString(),
          BlockDeviceMappings: [
            {
              Ebs: {
                SnapshotId: 'snap-old0001',
              },
            },
          ],
        },
        {
          ImageId: 'ami-old0002',
          CreationDate: date31DaysAgo.toISOString(),
        },
        {
          ImageId: 'ami-notOld0001',
          CreationDate: new Date(new Date().setDate(new Date().getDate() - 1)).toISOString(),
          BlockDeviceMappings: [
            {
              Ebs: {
                SnapshotId: 'snap-notOld0001',
              },
            },
          ],
        },
      ],
    });

    await amiCleanup({
      minimumDaysOld: deleteAmisOlderThenDays,
    });
    expect(mockEC2Client).toHaveReceivedCommandTimes(DeregisterImageCommand, 2);
    expect(mockEC2Client).toHaveReceivedCommandWith(DeregisterImageCommand, {
      ImageId: 'ami-old0001',
    });
    expect(mockEC2Client).toHaveReceivedCommandWith(DeleteSnapshotCommand, {
      SnapshotId: 'snap-old0001',
    });
    expect(mockEC2Client).toHaveReceivedCommandWith(DeregisterImageCommand, {
      ImageId: 'ami-old0002',
    });
    expect(mockEC2Client).not.toHaveReceivedCommandWith(DeregisterImageCommand, {
      ImageId: 'ami-notOld0001',
    });
    expect(mockEC2Client).not.toHaveReceivedCommandWith(DeleteSnapshotCommand, {
      SnapshotId: 'snap-notOld0001',
    });

    expect(mockEC2Client).toHaveReceivedCommandTimes(DeleteSnapshotCommand, 1);
  });

  it('should delete 1 AMIs AMI.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [
        {
          ImageId: 'ami-old0001',
          CreationDate: date31DaysAgo.toISOString(),
        },
      ],
    });

    await amiCleanup({
      minimumDaysOld: deleteAmisOlderThenDays,
      maxItems: 1,
    });
    expect(mockEC2Client).toHaveReceivedCommandTimes(DeregisterImageCommand, 1);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });

  it('should not delete a snapshot if ami deletion fails.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [
        ...imagesInUse,
        {
          ImageId: 'ami-old0001',
          CreationDate: date31DaysAgo.toISOString(),
          BlockDeviceMappings: [
            {
              Ebs: {
                SnapshotId: 'snap-old0001',
              },
            },
          ],
        },
      ],
    });

    mockEC2Client.on(DeregisterImageCommand).rejects({});

    await amiCleanup();
    expect(mockEC2Client).toHaveReceivedCommandTimes(DeregisterImageCommand, 1);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });

  it('should not fail when deleting a snahshot fails.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [
        ...imagesInUse,
        {
          ImageId: 'ami-old0001',
          CreationDate: date31DaysAgo.toISOString(),
          BlockDeviceMappings: [
            {
              Ebs: {
                SnapshotId: 'snap-old0001',
              },
            },
          ],
        },
      ],
    });

    mockEC2Client.on(DeleteSnapshotCommand).rejects({});

    await amiCleanup().catch(() => fail());
    expect(mockEC2Client).toHaveReceivedCommandTimes(DeregisterImageCommand, 1);
    expect(mockEC2Client).toHaveReceivedCommandTimes(DeleteSnapshotCommand, 1);
  });

  it('should not fail when no images are found.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: undefined,
    });

    await amiCleanup().catch(() => fail());
    expect(mockEC2Client).not.toHaveReceivedCommand(DeregisterImageCommand);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });

  it('should not delete images without a creation date.', async () => {
    mockEC2Client.on(DescribeImagesCommand, { Owners: ['self'] }).resolves({
      Images: [
        {
          ImageId: 'ami-noCreationDate0001',
          CreationDate: undefined,
        },
      ],
    });

    await amiCleanup().catch(() => fail());
    expect(mockEC2Client).not.toHaveReceivedCommand(DeregisterImageCommand);
    expect(mockEC2Client).not.toHaveReceivedCommand(DeleteSnapshotCommand);
  });
});
