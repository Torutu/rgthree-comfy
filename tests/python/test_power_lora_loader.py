"""Execution tests for the Power Lora Loader backend (py/power_lora_loader.py).

These check the contract between the UI and execution: what each row value the frontend sends
(see serializeLoraRowValue in src_web/comfyui/power_lora_loader_logic.ts) makes the backend do.

ComfyUI itself can't be imported here, so the ComfyUI modules the node imports (folder_paths,
nodes, server, requests) are replaced with small fakes first. The fake LoraLoader records each call
instead of patching a model.

Run:  python3 -m unittest discover -s tests/python -v     (or: make check)
"""
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

# Import the repo's `py` package (py/power_lora_loader.py), not anything else named `py`.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

LORA_FILES = ["style/anime.safetensors", "detail.safetensors", "second.safetensors"]


class FakeLoraLoader:
  """Stands in for ComfyUI's nodes.LoraLoader and records every load_lora call."""
  calls = []

  def load_lora(self, model, clip, lora_name, strength_model, strength_clip):
    FakeLoraLoader.calls.append((lora_name, strength_model, strength_clip))
    new_clip = None if clip is None else f"{clip}+{lora_name}"
    return (f"{model}+{lora_name}", new_clip)


def _install_fake_comfy_modules():
  folder_paths = types.ModuleType("folder_paths")
  folder_paths.get_filename_list = lambda kind: list(LORA_FILES)
  folder_paths.get_full_path = lambda kind, name: f"/models/{kind}/{name}"
  nodes = types.ModuleType("nodes")
  nodes.LoraLoader = FakeLoraLoader
  server = types.ModuleType("server")
  server.PromptServer = type("PromptServer", (), {"instance": None})
  sys.modules["folder_paths"] = folder_paths
  sys.modules["nodes"] = nodes
  sys.modules["server"] = server
  sys.modules.setdefault("requests", types.ModuleType("requests"))


_install_fake_comfy_modules()
from py import power_lora_loader as pll  # pylint: disable=wrong-import-position


def row(on=True, lora="detail.safetensors", strength=1.0, strength_two=None):
  """A row exactly as the frontend sends it: no strengthTwo key in single-strength mode."""
  value = {"on": on, "lora": lora, "strength": strength}
  if strength_two is not None:
    value["strengthTwo"] = strength_two
  return value


class LoadLorasTest(unittest.TestCase):

  def setUp(self):
    FakeLoraLoader.calls = []
    self.node = pll.RgthreePowerLoraLoader()

  def run_node(self, clip="clip", **inputs):
    return self.node.load_loras(model="model", clip=clip, **inputs)

  def test_enabled_row_is_applied_with_the_same_strength_for_model_and_clip(self):
    model, clip = self.run_node(lora_1=row(strength=0.7))
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0.7, 0.7)])
    self.assertEqual((model, clip), ("model+detail.safetensors", "clip+detail.safetensors"))

  def test_disabled_row_is_not_applied(self):
    model, clip = self.run_node(lora_1=row(on=False))
    self.assertEqual(FakeLoraLoader.calls, [])
    self.assertEqual((model, clip), ("model", "clip"))

  def test_zero_strength_row_is_skipped(self):
    self.run_node(lora_1=row(strength=0))
    self.assertEqual(FakeLoraLoader.calls, [])

  def test_separate_strengths_use_strength_two_for_clip(self):
    self.run_node(lora_1=row(strength=0.8, strength_two=0.3))
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0.8, 0.3)])

  def test_clip_only_strength_still_applies(self):
    self.run_node(lora_1=row(strength=0, strength_two=0.5))
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0, 0.5)])

  def test_without_clip_input_the_clip_strength_is_zero_and_a_warning_is_logged(self):
    with mock.patch.object(pll, "log_node_warn") as warn:
      model, clip = self.run_node(clip=None, lora_1=row(strength=0.9, strength_two=0.4))
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0.9, 0)])
    self.assertIsNone(clip)
    warn.assert_called_once()

  def test_missing_lora_file_is_skipped_and_the_others_still_apply(self):
    with mock.patch("py.power_prompt_utils.log_node_warn"):
      self.run_node(lora_1=row(lora="deleted.safetensors"), lora_2=row(lora="second.safetensors"))
    self.assertEqual(FakeLoraLoader.calls, [("second.safetensors", 1.0, 1.0)])

  def test_rows_apply_in_order_and_only_enabled_ones(self):
    self.run_node(
      lora_3=row(lora="second.safetensors", strength=0.2),
      lora_1=row(lora="detail.safetensors", on=False),
      lora_2=row(lora="style/anime.safetensors", strength=1.1),
    )
    self.assertEqual(
      FakeLoraLoader.calls,
      [("second.safetensors", 0.2, 0.2), ("style/anime.safetensors", 1.1, 1.1)],
    )

  def test_the_other_widgets_in_a_real_prompt_are_ignored(self):
    # Shape taken from a saved workflow: header + button widgets are sent as inputs too.
    self.run_node(**{
      "PowerLoraLoaderHeaderWidget": {"type": "PowerLoraLoaderHeaderWidget"},
      "lora_1": row(strength=0.5),
      "➕ Add Lora": "",
    })
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0.5, 0.5)])

  def test_input_names_are_case_insensitive(self):
    self.run_node(LORA_7=row(strength=0.4))
    self.assertEqual(FakeLoraLoader.calls, [("detail.safetensors", 0.4, 0.4)])

  def test_without_model_nothing_is_loaded(self):
    model, clip = self.node.load_loras(model=None, clip="clip", lora_1=row())
    self.assertEqual(FakeLoraLoader.calls, [])
    self.assertEqual((model, clip), (None, "clip"))


class EnabledLorasFromPromptTest(unittest.TestCase):

  def test_only_enabled_rows_with_existing_files_are_listed(self):
    prompt_node = {"inputs": {
      "lora_1": row(lora="detail.safetensors", strength=0.6),
      "lora_2": row(lora="second.safetensors", on=False),
      "lora_3": row(lora="style/anime.safetensors", strength=1, strength_two=0.25),
      "lora_4": row(lora="missing.safetensors"),
    }}
    with mock.patch("py.power_prompt_utils.log_node_warn"):
      loras = pll.RgthreePowerLoraLoader.get_enabled_loras_from_prompt_node(prompt_node)
    self.assertEqual(loras, [
      {"name": "detail.safetensors", "strength": 0.6, "path": "/models/loras/detail.safetensors"},
      {
        "name": "style/anime.safetensors",
        "strength": 1,
        "path": "/models/loras/style/anime.safetensors",
        "strength_clip": 0.25,
      },
    ])


if __name__ == "__main__":
  unittest.main()
