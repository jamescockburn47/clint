"""App-only gate and rollback tests; every service action is mocked."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import deploy

class DeploymentTests(unittest.TestCase):
    def fixture(self, directory):
        root=Path(directory); control=root/'control'; control.mkdir(mode=0o700)
        stage=root/'stage'; (stage/'app').mkdir(parents=True)
        base=root/'releases/base'; base.mkdir(parents=True)
        runtime=root/'runtime'; runtime.mkdir()
        for name in ['controller.py','lifecycle.py','thermal_profile.py','fan_governor.py','cleanup.py']:
            (runtime/name).write_text('unchanged runtime')
        (base/'app.js').write_text('old app'); (stage/'app/app.js').write_text('new app')
        current=root/'current'; current.symlink_to(base)
        env=root/'runtime.env'; env.write_bytes(b'EXACT=unchanged\r\n')
        def save(name,obj): (control/name).write_text(json.dumps(obj))
        (stage/'verify.log').write_text('passed')
        save('manifest.json',{'app.js':deploy.sha(stage/'app/app.js')})
        save('verify.json',{'exit':0,'manifestSha256':deploy.sha(control/'manifest.json'),
            'logSha256':deploy.sha(stage/'verify.log')})
        save('base-hashes.json',{'app.js':deploy.sha(base/'app.js')})
        save('runtime-hashes.json',{p.name:deploy.sha(p) for p in runtime.iterdir()})
        save('approval.json',{'approved':True,'files':{'manifest.json':deploy.sha(control/'manifest.json')}})
        p=patch.multiple(deploy,ROOT=control,STAGE=stage,BASE=base,RUNTIME=runtime,CURRENT=current,
            ENVIRONMENT=env,LEASE=root/'absent-lease')
        p.start(); self.addCleanup(p.stop)
        return control

    def test_failed_gate_stops_no_services(self):
        for failure in ['approval','pin','runtime']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                root=self.fixture(directory)
                if failure=='approval': (root/'approval.json').write_text('{"approved":false}')
                elif failure=='pin': (root/'manifest.json').write_text('{}')
                else: (root/'runtime-hashes.json').write_text('{}')
                with patch.object(deploy,'run') as run:
                    with self.assertRaises(RuntimeError): deploy.main()
                    run.assert_not_called()

    def test_activation_failure_restores_app_and_exact_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.fixture(directory)
            def ready(target, version):
                if version=='clint-shared-core-v45': raise RuntimeError('forced_activation_failure')
                self.assertEqual(target,deploy.BASE)
                return {'ready':True}
            with patch.object(deploy,'run',return_value=''),patch.object(deploy,'ready',side_effect=ready):
                with self.assertRaisesRegex(RuntimeError,'forced_activation_failure'): deploy.main()
            self.assertEqual(deploy.CURRENT.resolve(),deploy.BASE)
            self.assertEqual(deploy.ENVIRONMENT.read_bytes(),b'EXACT=unchanged\r\n')
            self.assertTrue(deploy.read(root/'rollback.json')['environmentRestored'])
            self.assertFalse(deploy.read(root/'rollback.json')['publicTemporarilyDisabled'])

if __name__=='__main__': unittest.main()
