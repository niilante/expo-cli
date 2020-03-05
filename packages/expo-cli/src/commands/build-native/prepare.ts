import { Android, BuildConfig, BuildType, Job, JobSchema, Platform, iOS } from '@expo/build-tools';

export type Options = {
  platform: Platform;
};

function validateJob(job: Job): Job {
  console.log(job);
  const { value, error } = JobSchema.validate(job);
  if (error) {
    throw error;
  } else {
    return value;
  }
}

async function prepareJob(options: Options, projectUrl: string, projectDir: string): Promise<Job> {
  const turtleJson = await BuildConfig.read(projectDir);

  switch (options.platform) {
    case Platform.Android:
      switch (turtleJson.type) {
        case BuildType.Generic:
          return validateJob(
            await BuildConfig.prepareAndroidGenericJob(turtleJson, projectUrl, projectDir)
          );
        case BuildType.Managed:
          return validateJob(
            await BuildConfig.prepareAndroidManagedJob(turtleJson, projectUrl, projectDir)
          );
        default:
          throw new Error('Unsupported build type');
      }
    case Platform.iOS:
      switch (turtleJson.type) {
        case BuildType.Generic:
          return validateJob(
            await BuildConfig.prepareiOSGenericJob(turtleJson, projectUrl, projectDir)
          );
        case BuildType.Managed:
          return validateJob(
            await BuildConfig.prepareiOSManagedJob(turtleJson, projectUrl, projectDir)
          );
        default:
          throw new Error('Unsupported build type');
      }
    default:
      throw new Error('Unsupported platform');
  }
}

export { prepareJob };
