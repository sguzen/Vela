// Public entry for the from-scratch MyFundedPerps data provider, published as the
// `vela/providers/myfundedperps` subpath. No provider is bundled into the main
// entry — register this one explicitly:
//   import { MyFundedPerpsProvider } from 'vela/providers/myfundedperps';
//   chart.data.registerProvider('mfp', new MyFundedPerpsProvider());
export { MyFundedPerpsProvider } from './MyFundedPerpsProvider';
export { MarketStream } from './MarketStream';
export type { SocketLike, SocketFactory, MarketStreamOptions } from './MarketStream';
export type { SymbolDescriptor, ProviderInfo, DataProvider } from '../../../core/ports/DataProvider';
