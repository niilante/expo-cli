// @flow

import chalk from 'chalk';
import fse from 'fs-extra';
import matchRequire from 'match-require';
import npmPackageArg from 'npm-package-arg';
import path from 'path';
import spawn from 'cross-spawn';
import pacote from 'pacote';
import tmp from 'tmp';
import spawnAsync from '@expo/spawn-async';
import { Exp, ProjectUtils, Detach, Versions } from '@expo/xdl';
import * as ConfigUtils from '@expo/config';

import log from '../../log';
import prompt from '../../prompt';
import { loginOrRegisterIfLoggedOut } from '../../accounts';

const EXPO_APP_ENTRY = 'node_modules/expo/AppEntry.js';

export async function ejectAsync(projectRoot: string, options) {
  let workingTreeStatus = 'unknown';
  try {
    let result = await spawnAsync('git', ['status', '--porcelain']);
    workingTreeStatus = result.stdout === '' ? 'clean' : 'dirty';
  } catch (e) {
    // Maybe git is not installed?
    // Maybe this project is not using git?
  }

  if (workingTreeStatus === 'clean') {
    log.nested(`Your git working tree is ${chalk.green('clean')}`);
    log.nested('To revert the changes from ejecting later, you can use these commands:');
    log.nested('  git clean --force && git reset --hard');
  } else if (workingTreeStatus === 'dirty') {
    log.nested(`${chalk.bold('Warning!')} Your git working tree is ${chalk.red('dirty')}.`);
    log.nested(
      `It's recommended to ${chalk.bold(
        'commit all your changes before proceeding'
      )},\nso you can revert the changes made by this command if necessary.`
    );
  } else {
    log.nested("We couldn't find a git repository in your project directory.");
    log.nested("It's recommended to back up your project before proceeding.");
  }

  log.nested('');

  let reactNativeOptionMessage = "Bare: I'd like a bare React Native project.";

  const questions = [
    {
      type: 'list',
      name: 'ejectMethod',
      message:
        'How would you like to eject your app?\n  Read more: https://docs.expo.io/versions/latest/expokit/eject/',
      default: 'bare',
      choices: [
        {
          name: reactNativeOptionMessage,
          value: 'bare',
          short: 'Bare',
        },
        {
          name:
            "ExpoKit: I'll create or log in with an Expo account to use React Native and the Expo SDK.",
          value: 'expokit',
          short: 'ExpoKit',
        },
        {
          name: "Cancel: I'll continue with my current project structure.",
          value: 'cancel',
          short: 'cancel',
        },
      ],
    },
  ];

  const ejectMethod =
    options.ejectMethod ||
    (await prompt(questions, {
      nonInteractiveHelp: 'Please specify eject method (bare, expokit) with the --eject-method option.',
    })).ejectMethod;

  if (ejectMethod === 'bare') {
    await ejectToBareAsync(projectRoot, options);
  } else if (ejectMethod === 'expokit') {
    await loginOrRegisterIfLoggedOut();
    await Detach.detachAsync(projectRoot, options);
  } else if (ejectMethod === 'cancel') {
    // we don't want to print the survey for cancellations
    log('OK! If you change your mind you can run this command again.');
    return;
  } else {
    throw new Error(
      `Unrecognized eject method "${ejectMethod}". Valid options are: bare, expokit.`
    );
  }

  log(chalk.green('Ejected successfully!'));
}

async function ejectToBareAsync(projectRoot, options) {
  const useYarn = ConfigUtils.isUsingYarn(projectRoot);
  const npmOrYarn = useYarn ? 'yarn' : 'npm';
  const { configPath, configName } = await ConfigUtils.findConfigFileAsync(projectRoot);
  const { exp, pkg: pkgJson } = await ProjectUtils.readConfigJsonAsync(projectRoot);
  const appJson = configName === 'app.json' ? JSON.parse(await fse.readFile(configPath)) : {};

  /**
   * Perform validations
   */
  if (!exp) throw new Error(`Couldn't read ${configName}`);
  if (!pkgJson) throw new Error(`Couldn't read package.json`);

  if (!Versions.gteSdkVersion(exp, '33.0.0')) {
    throw new Error(`Ejecting to a bare project is only available for SDK 33 and higher`);
  }

  // Validate that the template exists
  let sdkMajorVersionNumber = semver.major(exp.sdkVersion);
  let templateSpec = npmPackageArg(`expo-template-bare-minimum@sdk-${sdkMajorVersionNumber}`);
  try {
    await pacote.manifest(templateSpec);
  } catch (e) {
    throw new Error(
      `Unable to eject because an eject template for SDK ${sdkMajorVersionNumber} was not found`
    );
  }

  /**
   * Customize app.json
   */
  let { displayName, name } = await getAppNamesAsync(projectRoot);
  appJson.displayName = displayName;
  appJson.name = name;

  if (appJson.expo.entryPoint && appJson.expo.entryPoint !== EXPO_APP_ENTRY) {
    log(
      chalk.yellow(`expo.entryPoint is already configured, we recommend using "${EXPO_APP_ENTRY}`)
    );
  } else {
    appJson.expo.entryPoint = EXPO_APP_ENTRY;
  }

  log('Writing app.json...');
  await fse.writeFile(path.resolve('app.json'), JSON.stringify(appJson, null, 2));
  log(chalk.green('Wrote to app.json, please update it manually in the future.'));

  /**
   * Extract the template and copy it over
   */
  try {
    let tempDir = tmp.dirSync();
    await Exp.extractTemplateAppAsync(templateSpec, tempDir.name, appJson);
    fse.copySync(path.join(tempDir.name, 'ios'), path.join(projectRoot, 'ios'));
    fse.copySync(path.join(tempDir.name, 'android'), path.join(projectRoot, 'android'));
    tempDir.removeCallback();
    log('Successfully copied template native code.');
  } catch (e) {
    log(chalk.red(e.message));
    log(chalk.red(`Eject failed, see above output for any issues.`));
    log(chalk.yellow('You may want to delete the `ios` and/or `android` directories.'));
    process.exit(1);
  }

  log(`Updating your ${npmOrYarn} scripts in package.json...`);
  if (!pkgJson.scripts) {
    pkgJson.scripts = {};
  }
  delete pkgJson.scripts.eject;
  pkgJson.scripts.start = 'react-native start';
  pkgJson.scripts.ios = 'react-native run-ios';
  pkgJson.scripts.android = 'react-native run-android';

  const { sdkVersion } = exp;
  const versions = await Versions.versionsAsync();
  const reactNativeVersion = versions.sdkVersions[sdkVersion].facebookReactNativeVersion;
  pkgJson.dependencies['react-native'] = reactNativeVersion;

  // TODO: how should we version react-native-unimodules to match up with react-native version?
  pkgJson.dependencies['react-native-unimodules'] = '^0.4.1';

  await fse.writeFile(path.resolve('package.json'), JSON.stringify(pkgJson, null, 2));

  log(chalk.green('Your package.json is up to date!'));

  log(`Adding entry point...`);
  delete pkgJson.main;

  const indexjs = `import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('${appJson.name}', () => App);
`;
  await fse.writeFile(path.resolve('index.js'), indexjs);
  log(chalk.green('Added new entry points!'));

  log(`
Note that using \`${npmOrYarn} start\` will now require you to run Xcode and/or
Android Studio to build the native code for your project.`);

  log('Removing node_modules...');
  await fse.remove('node_modules');
  if (useYarn) {
    log('Installing packages with yarn...');
    spawn.sync('yarnpkg', [], { stdio: 'inherit' });
  } else {
    // npm prints the whole package tree to stdout unless we ignore it.
    const stdio = [process.stdin, 'ignore', process.stderr];

    log('Installing existing packages with npm...');
    spawn.sync('npm', ['install'], { stdio });
  }
}

async function getAppNamesAsync(projectRoot) {
  const { configPath, configName } = await ConfigUtils.findConfigFileAsync(projectRoot);
  const { exp, pkg: pkgJson } = await ConfigUtils.readConfigJsonAsync(projectRoot);
  const appJson = configName === 'app.json' ? JSON.parse(await fse.readFile(configPath)) : {};

  let { displayName, name } = appJson;
  if (!displayName || !name) {
    log("We have a couple of questions to ask you about how you'd like to name your app:");
    ({ displayName, name } = await prompt(
      [
        {
          name: 'displayName',
          message: "What should your app appear as on a user's home screen?",
          default: name || exp.name,
          validate: s => {
            return s.length > 0 ? true : 'App display name cannot be empty.';
          },
        },
        {
          name: 'name',
          message: 'What should your Android Studio and Xcode projects be called?',
          default: pkgJson.name ? stripDashes(pkgJson.name) : undefined,
          validate: s => {
            if (s.length === 0) {
              return 'Project name cannot be empty.';
            } else if (s.indexOf('-') !== -1 || s.indexOf(' ') !== -1) {
              return 'Project name cannot contain hyphens or spaces.';
            }
            return true;
          },
        },
      ],
      {
        nonInteractiveHelp: 'Please specify "displayName" and "name" in app.json.',
      }
    ));
  }

  return { displayName, name };
}

function stripDashes(s: string): string {
  let ret = '';

  for (let c of s) {
    if (c !== ' ' && c !== '-') {
      ret += c;
    }
  }

  return ret;
}
