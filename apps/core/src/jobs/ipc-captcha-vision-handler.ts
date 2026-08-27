import type { TaskHandler } from './ipc-types.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { solveCaptchaVision } from './captcha-vision-solver.js';

export const captchaVisionTaskHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const responder = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const imageBase64 = toTrimmedString(data.payload?.imageBase64, {
    maxLen: 7_000_000,
  });
  const mimeType = toTrimmedString(data.payload?.mimeType, { maxLen: 80 });
  const pageUrl = toTrimmedString(data.payload?.pageUrl, { maxLen: 2_048 });
  if (
    !data.appId ||
    !imageBase64 ||
    !/^image\/(?:png|jpeg|webp)$/u.test(mimeType ?? '')
  ) {
    responder.reject('Invalid CAPTCHA vision request.', 'invalid_request');
    return;
  }
  try {
    const result = await solveCaptchaVision({
      appId: data.appId,
      imageBase64,
      mimeType: mimeType!,
      ...(pageUrl ? { pageUrl } : {}),
    });
    responder.acceptData('CAPTCHA vision attempt completed.', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const failureCode = /status\s+\d+/iu.test(message)
      ? 'vision_provider_rejected'
      : /provider|gateway|model/iu.test(message)
        ? 'vision_configuration_unavailable'
        : 'vision_execution_failed';
    responder.acceptData('CAPTCHA vision attempt was inconclusive.', {
      solved: false,
      failureCode,
    });
  }
};
