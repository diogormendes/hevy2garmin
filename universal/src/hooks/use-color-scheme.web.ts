import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

const subscribeNoop = () => () => {};

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web.
 * Hydration is read through useSyncExternalStore (false on the server snapshot, true on the
 * client) instead of a setState inside an effect.
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(subscribeNoop, () => true, () => false);

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
