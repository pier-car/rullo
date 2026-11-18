# Compila l'app: unisce template.html, core.js e app.js in ../index.html (la pagina pubblicata).
# Uso, dalla cartella principale del repository:  python3 src/build.py
import os
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda n: open(os.path.join(here, n), encoding='utf-8').read()
core = rd('core.js').replace("if (typeof module !== 'undefined') module.exports = Core;", "")
t = rd('template.html').replace('/*__CORE__*/', core).replace('/*__APP__*/', rd('app.js'))
out = os.path.join(here, '..', 'index.html')
open(out, 'w', encoding='utf-8').write(t)
print('index.html', len(t))
