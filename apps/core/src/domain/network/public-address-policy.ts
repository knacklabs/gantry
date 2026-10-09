export {
  hostnameForNetwork,
  isIpAddress,
  isLoopbackAddress,
  isPrivateNetworkAddress,
} from '../../shared/public-address-policy.js';

export type ResolvedPublicAddress = {
  address: string;
  family: 4 | 6;
};

export type HostnameLookup = (
  hostname: string,
) => Promise<ResolvedPublicAddress[]>;
