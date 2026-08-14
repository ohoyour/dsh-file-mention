//#region src/index.ts
/**
* Node half of the web client plugin. Pure UI plugin: the empty apply exists
* so the row appears in the host composition and the Loader can mount it;
* the browser half ships via exports["./client"], discovered through the
* package.json `dsh.client` declaration.
*/
/** Host plugin body — no host-side behavior for this source plugin. */
function apply() {}
//#endregion
export { apply };
