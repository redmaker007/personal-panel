import * as currentData from '../../assets/sf-data.mjs';
import * as currentEngine from '../../assets/sf-engine.mjs';
import * as previousData from '../../assets/sf-data-v21.mjs';
import * as previousEngine from '../../assets/sf-engine-v21.mjs';
export const implementations={
  [previousData.CATALOG_VERSION]:{...previousData,...previousEngine},
  [currentData.CATALOG_VERSION]:{...currentData,...currentEngine}
};
export function versionImplementation(version){return Object.hasOwn(implementations,version)?implementations[version]:null;}
