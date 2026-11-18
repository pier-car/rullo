# Nei test i caratteri web non servono: le richieste ai font vengono soddisfatte a vuoto.
async def setup(ctx):
    async def h(route):
        u = route.request.url
        if 'fonts.googleapis.com' in u: await route.fulfill(status=200, content_type='text/css', body='')
        elif 'fonts.gstatic.com' in u: await route.abort()
        else: await route.continue_()
    await ctx.route('**/*', h)
