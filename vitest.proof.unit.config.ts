// JUnit proof runs for `forge stage done`: identical to the unit config,
// plus the file attribute the stage gate attributes test cases by.
import { mergeConfig } from 'vitest/config';
import base from './vitest.unit.config.js';

export default mergeConfig(base, {
  test: { reporters: [['junit', { addFileAttribute: true }]] },
});
