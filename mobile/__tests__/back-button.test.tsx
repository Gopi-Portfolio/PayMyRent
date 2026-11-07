import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { BackButton } from '@/components/ui';

let mockPath = '/phone';
const mockRouter = { canGoBack: jest.fn(), back: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ usePathname: () => mockPath, get router() { return mockRouter; }, useFocusEffect: () => undefined }));    // read when used, after mockRouter exists
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

beforeEach(() => { Object.values(mockRouter).forEach((f) => f.mockReset()); });

test('on the mobile-number screen there is a back button that returns to the plans', () => {
  mockPath = '/phone'; mockRouter.canGoBack.mockReturnValue(true);
  const ui = render(<BackButton />);
  fireEvent.press(ui.getByTestId('back'));
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
});

test('and still when the app opened straight on it: back goes to the landing page', () => {
  mockPath = '/phone'; mockRouter.canGoBack.mockReturnValue(false);
  const ui = render(<BackButton />);
  fireEvent.press(ui.getByTestId('back'));
  expect(mockRouter.replace).toHaveBeenCalledWith('/');
});

test('home screens still have no back button, and other screens only when there is somewhere to go back to', () => {
  mockRouter.canGoBack.mockReturnValue(true);
  mockPath = '/owner'; expect(render(<BackButton />).queryByTestId('back')).toBeNull();
  mockPath = '/tenant'; expect(render(<BackButton />).queryByTestId('back')).toBeNull();
  mockPath = '/otp'; expect(render(<BackButton />).queryByTestId('back')).not.toBeNull();
  mockRouter.canGoBack.mockReturnValue(false);
  mockPath = '/otp'; expect(render(<BackButton />).queryByTestId('back')).toBeNull();
});
