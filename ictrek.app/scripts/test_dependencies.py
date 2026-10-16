import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import package
import yaml


class UnifiedGatewayDependencyTests(unittest.TestCase):
    def test_source_and_staged_package_use_unified_gateway(self):
        source = yaml.safe_load((package.SRC / 'manifest.yml').read_text())
        self.assertEqual(source['dependencies']['apps'], [
            {'id': 'com.ictrek.v-scheduler', 'version': 'latest', 'optional': False},
        ])
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'manifest.yml').write_text(yaml.safe_dump(source))
            with patch.dict(os.environ, {'VOS_DEPENDENCY_CATALOG_URL': 'http://127.0.0.1:18899'}), patch(
                'resolve_dependencies.appstore_version', return_value='0.1.99'
            ):
                package.resolve_manifest(stage)
            staged = yaml.safe_load((stage / 'manifest.yml').read_text())
            self.assertEqual(staged['dependencies']['apps'][0]['version'], '>=0.1.99')
            self.assertEqual(source['dependencies']['apps'][0]['version'], 'latest')

    def test_missing_publication_stops_packaging(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'manifest.yml').write_text((package.SRC / 'manifest.yml').read_text())
            with patch.dict(os.environ, {'VOS_DEPENDENCY_CATALOG_URL': 'http://127.0.0.1:18899'}), patch(
                'resolve_dependencies.appstore_version', side_effect=RuntimeError('no verified latest published App Store package')
            ), self.assertRaisesRegex(RuntimeError, 'no verified latest'):
                package.resolve_manifest(stage)


if __name__ == '__main__':
    unittest.main()
