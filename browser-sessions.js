function createBrowserSessionManager() {
    const contexts = new Map();

    function getPersistentContext(provider, launch) {
        const existingContext = contexts.get(provider);
        if (existingContext) return existingContext;

        let contextPromise;
        contextPromise = Promise.resolve()
            .then(launch)
            .then(context => {
                context.on("close", () => {
                    if (contexts.get(provider) === contextPromise) {
                        contexts.delete(provider);
                    }
                });
                return context;
            })
            .catch(error => {
                if (contexts.get(provider) === contextPromise) {
                    contexts.delete(provider);
                }
                throw error;
            });
        contexts.set(provider, contextPromise);
        return contextPromise;
    }

    async function closeAllPersistentContexts() {
        const activeContexts = [...contexts.values()];
        contexts.clear();
        await Promise.allSettled(activeContexts.map(async contextPromise => {
            const context = await contextPromise;
            await context.close();
        }));
    }

    return { closeAllPersistentContexts, getPersistentContext };
}

async function getProviderPage(context, hostnames) {
    const pages = context.pages();
    const existingPage = pages.find(page => {
        try {
            const hostname = new URL(page.url()).hostname;
            return hostnames.some(host => hostname === host || hostname.endsWith(`.${host}`));
        } catch {
            return false;
        }
    });

    return existingPage || pages[0] || context.newPage();
}

const browserSessionManager = createBrowserSessionManager();

module.exports = {
    closeAllPersistentContexts: browserSessionManager.closeAllPersistentContexts,
    createBrowserSessionManager,
    getPersistentContext: browserSessionManager.getPersistentContext,
    getProviderPage
};