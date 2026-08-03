import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its own cleanup when the test globals are
// injected. They are not, so unmount explicitly — otherwise every render
// accumulates in the same document and assertions match earlier tests' output.
afterEach(cleanup);
