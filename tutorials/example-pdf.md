---
engine: marimo
engines:
- path: /Users/gordon/src/quarto-marimo/\_extensions/marimo/marimo-engine.js
extract-media: \_site/media
format: pdf
pyproject: |
  requires-python = "\>=3.11" dependencies = \[ "numpy", "pandas",
  "matplotlib", "marimo\>=0.13.3"\]
title: PDF example
toc-title: Table of contents
---

    Error executing marimo: Process execution failed: Traceback (most recent call last):
      File "/Users/gordon/src/quarto-marimo/_extensions/marimo/extract.py", line 11, in <module>
        import html2text
    ModuleNotFoundError: No module named 'html2text'

# PDF Output

``` python.marimo
check = """
Quarto can handle images and tables in PDF output, but not rich HTML outputs.
Here's an example of what can be acccomplished with the `marimo` exports to pdf.
"""

if missing_packages:
  check = """
Normally you would see plots and tables in this pdf, but the required packages are not installed.
"""

mo.md(check)
```

## Images

We can still do plots!

``` python3
# create the plot in the last line of the cell
import matplotlib.pyplot as plt
plt.plot([1, 2])
```

``` python.marimo
plt.plot([1, 2])
plt.gca()
```

## Tables

We can also do tables!

``` python3
import pandas as pd
df = pd.DataFrame({
    'A': [1, 2, 3],
    'B': [4, 5, 6]
})
df
```

``` python.marimo
df = pd.DataFrame({
    'A': [1, 2, 3],
    'B': [4, 5, 6]
})
df
```

## Text / Markdown

``` python.marimo
f"""You can also include text or markdown in the PDF output.
Which can be useful for embedding computed values like the fact
that this was rendered by Marimo {mo.__version__} on {datetime.datetime.now()}.
"""
```

``` python.marimo
try:
    import matplotlib
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import datetime
    missing_packages = False
except ModuleNotFoundError:
    missing_packages = True

if not missing_packages:
    matplotlib.rcParams['figure.figsize'] = (6, 2.4)
```

``` python.marimo
import marimo as mo
```
