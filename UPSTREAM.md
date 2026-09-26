# Upstream provenance

Layaview is derived from [andududu/jeview](https://github.com/andududu/jeview), an MIT-licensed local visualizer for TypeSafe Jev.

BrickHouse fork baseline:

- upstream repository: `andududu/jeview`
- upstream commit: `495a4e43e9d67e495a66ab0d9e55ac1c5c4040d6`
- BrickHouse baseline tag: `jeview-upstream-495a4e43`
- BrickHouse repository: `brickhousestudios/layaview`

The `upstream` Git remote should continue to point at `https://github.com/andududu/jeview.git` so later fixes can be inspected and selectively adapted.

Layaview keeps Jeview's graph, event, search, SQLite, and local-security foundation while changing the native model/backend assumption from TypeSafe Jev to local Laya.
