import { existsSync } from 'node:fs';

/** Prefer an explicit browser, then system Chromium, then Playwright's bundle. */
export function browserExecutable(){
 if(process.env.IEP_BROWSER_EXECUTABLE){if(!existsSync(process.env.IEP_BROWSER_EXECUTABLE))throw Error('IEP_BROWSER_EXECUTABLE does not exist');return process.env.IEP_BROWSER_EXECUTABLE;}
 return existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined;
}
export async function launchBrowser({args=[],...options}={}){
 const {chromium}=await import('playwright');
 return chromium.launch({...options,executablePath:browserExecutable(),args:['--no-sandbox','--disable-dev-shm-usage',...args]});
}
