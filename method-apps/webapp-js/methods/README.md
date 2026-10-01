# Methods

One directory per method this app runs, and `npm run codegen` projects the typed tree under `src/generated/<name>/` from each. `make add-method` writes the directory whatever the method is: it copies a bundle in, or writes the `method.json` of a method that lives elsewhere. Given a directory already in here, it scaffolds that directory's files where they are.

A method directory holds either the method's own `.mthds` files or a `method.json` that names a method living elsewhere — a catalog id (`mt_…`) or a published package address — never both. A file at this level, like this one, is not a method.

See [`docs/add-method.md`](../docs/add-method.md) and [`docs/codegen.md`](../docs/codegen.md).
