from pathlib import Path
import shutil
root = Path(__file__).resolve().parent.parent
assets = root / 'apps/android/app/src/main/assets'
expected_parent = (root / 'apps/android/app/src/main').resolve()
assert assets.resolve().parent == expected_parent and not assets.is_symlink(), 'Unsafe asset directory'
if assets.exists(): shutil.rmtree(assets)
shutil.copytree(root / 'apps/desktop/dist', assets)
print('Shared renderer packaged in APK assets.')
