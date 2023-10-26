import { logger } from '@terraform-aws-github-runner/aws-powertools-util';
import { Context } from 'aws-lambda';
import { mocked } from 'jest-mock';

import { AmiCleanupOptions, amiCleanup } from './ami';
import { housekeeperAmi } from './lambda';

jest.mock('./ami');
jest.mock('@terraform-aws-github-runner/aws-powertools-util');

const amiCleanupOptions: AmiCleanupOptions = {
  minimumDaysOld: 7,
};

process.env.AMI_CLEANUP_OPTIONS = JSON.stringify(amiCleanupOptions);

const context: Context = {
  awsRequestId: '1',
  callbackWaitsForEmptyEventLoop: false,
  functionName: '',
  functionVersion: '',
  getRemainingTimeInMillis: () => 0,
  invokedFunctionArn: '',
  logGroupName: '',
  logStreamName: '',
  memoryLimitInMB: '',
  done: () => {
    return;
  },
  fail: () => {
    return;
  },
  succeed: () => {
    return;
  },
};

// Docs for testing async with jest: https://jestjs.io/docs/tutorial-async
describe('Housekeeper ami', () => {
  beforeAll(() => {
    jest.resetAllMocks();
  });

  it('should not throw or log in error.', async () => {
    const mock = mocked(amiCleanup);
    mock.mockImplementation(() => {
      return new Promise((resolve) => {
        resolve();
      });
    });
    expect(await housekeeperAmi(undefined, context)).resolves;
  });

  it('should not thow only log in error in case of an exception.', async () => {
    const logSpy = jest.spyOn(logger, 'error');

    const error = new Error('An error.');
    const mock = mocked(amiCleanup);
    mock.mockRejectedValue(error);
    await expect(housekeeperAmi(undefined, context)).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
