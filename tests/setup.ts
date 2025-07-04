import { jest } from '@jest/globals';

// Global test setup
beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests
  
  // Mock console methods to reduce test output noise
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  
  // Only show errors in tests
  jest.spyOn(console, 'error').mockImplementation((message) => {
    if (process.env.SHOW_TEST_ERRORS === 'true') {
      console.error(message);
    }
  });
});

afterAll(() => {
  // Restore console methods
  jest.restoreAllMocks();
});

// Global test utilities
global.mockFetch = (mockResponse: any) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => mockResponse,
    text: async () => JSON.stringify(mockResponse),
  });
};

global.mockFetchError = (error: Error) => {
  global.fetch = jest.fn().mockRejectedValue(error);
};

// Mock timers for tests that use setTimeout/setInterval
global.setupTimers = () => {
  jest.useFakeTimers();
};

global.teardownTimers = () => {
  jest.useRealTimers();
};

// Extend Jest matchers
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

// Type declarations for custom matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
    }
  }
  
  var mockFetch: (mockResponse: any) => void;
  var mockFetchError: (error: Error) => void;
  var setupTimers: () => void;
  var teardownTimers: () => void;
}