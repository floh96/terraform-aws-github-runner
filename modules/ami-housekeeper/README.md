# Module - AMI Housekeeper


## Usages

## Lambda Function

The Lambda function is written in [TypeScript](https://www.typescriptlang.org/) and requires Node and yarn. Sources are located in [./lamdas].

### Install

```bash
cd lambdas
yarn install
```

### Test

Test are implemented with [Jest](https://jestjs.io/), calls to AWS and GitHub are mocked.

```bash
yarn run test
```

### Package

To compile all TypeScript/JavaScript sources in a single file [ncc](https://github.com/zeit/ncc) is used.

```bash
yarn run dist
```

<!-- BEGIN_TF_DOCS -->

<!-- END_TF_DOCS -->
