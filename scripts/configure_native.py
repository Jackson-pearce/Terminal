#!/usr/bin/env python3
"""Add camera/microphone declarations after `npx cap add android` or `ios`."""
from pathlib import Path
import plistlib
import shutil
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
ANDROID_NS = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID_NS)


def configure_android():
    path = ROOT / "android/app/src/main/AndroidManifest.xml"
    if not path.exists():
        print("Android project not found; run npx cap add android first.")
        return False
    branding = ROOT / "resources/native/android"
    if branding.exists():
        shutil.copytree(branding, path.parent / "res", dirs_exist_ok=True)
    tree = ET.parse(path)
    manifest = tree.getroot()
    application = manifest.find("application")
    if application is not None:
        application.set(f"{{{ANDROID_NS}}}allowBackup", "false")
        application.set(f"{{{ANDROID_NS}}}usesCleartextTraffic", "false")
    existing = {node.get(f"{{{ANDROID_NS}}}name") for node in manifest.findall("uses-permission")}
    for permission in ("android.permission.CAMERA", "android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"):
        if permission not in existing:
            ET.SubElement(manifest, "uses-permission", {f"{{{ANDROID_NS}}}name": permission})
    ET.indent(tree, space="    ")
    tree.write(path, encoding="utf-8", xml_declaration=True)
    activity = ROOT / "android/app/src/main/java/chat/quad/messenger/MainActivity.java"
    if activity.exists() and "FLAG_SECURE" not in activity.read_text(encoding="utf-8"):
        source = activity.read_text(encoding="utf-8")
        empty = "public class MainActivity extends BridgeActivity {}"
        if empty in source:
            source = source.replace("import com.getcapacitor.BridgeActivity;", "import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\nimport android.view.WindowManager;")
            source = source.replace(empty, """public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}""")
            activity.write_text(source, encoding="utf-8")
        else:
            print("Custom MainActivity detected. Add FLAG_SECURE manually if desired.")
    print("Android media permissions, encrypted-transport policy, and privacy flags configured.")
    return True


def configure_ios():
    path = ROOT / "ios/App/App/Info.plist"
    if not path.exists():
        print("iOS project not found; run npx cap add ios first.")
        return False
    branding = ROOT / "resources/native/ios"
    if branding.exists():
        assets = path.parent / "Assets.xcassets"
        shutil.copy2(branding / "AppIcon-512@2x.png", assets / "AppIcon.appiconset/AppIcon-512@2x.png")
        for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
            shutil.copy2(branding / "splash.png", assets / "Splash.imageset" / name)
    with path.open("rb") as source:
        info = plistlib.load(source)
    info["NSCameraUsageDescription"] = "Quad uses the camera when you choose to send a photo or start a video call."
    info["NSMicrophoneUsageDescription"] = "Quad uses the microphone when you record a voice message or join a call."
    info["NSPhotoLibraryUsageDescription"] = "Quad lets you choose photos to share in a conversation."
    with path.open("wb") as dest:
        plistlib.dump(info, dest, sort_keys=False)
    privacy = path.parent / "PrivacyInfo.xcprivacy"
    if not privacy.exists():
        with privacy.open("wb") as dest:
            plistlib.dump({
                "NSPrivacyTracking": False,
                "NSPrivacyCollectedDataTypes": [],
                "NSPrivacyAccessedAPITypes": [{
                    "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
                    "NSPrivacyAccessedAPITypeReasons": ["C617.1"],
                }],
            }, dest, sort_keys=False)
    project = ROOT / "ios/App/App.xcodeproj/project.pbxproj"
    if project.exists():
        source = project.read_text(encoding="utf-8")
        if "PrivacyInfo.xcprivacy" not in source:
            source = source.replace("/* Begin PBXBuildFile section */", "/* Begin PBXBuildFile section */\n\t\tAA0000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = AA0000000000000000000002 /* PrivacyInfo.xcprivacy */; };")
            source = source.replace("/* Begin PBXFileReference section */", "/* Begin PBXFileReference section */\n\t\tAA0000000000000000000002 /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = \"<group>\"; };")
            source = source.replace("\t\t\t\t504EC3131FED79650016851F /* Info.plist */,", "\t\t\t\t504EC3131FED79650016851F /* Info.plist */,\n\t\t\t\tAA0000000000000000000002 /* PrivacyInfo.xcprivacy */,")
            source = source.replace("\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,", "\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,\n\t\t\t\tAA0000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */,")
            project.write_text(source, encoding="utf-8")
    print("iOS media descriptions and filesystem privacy manifest configured.")
    return True


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    if target not in {"android", "ios", "all"}:
        raise SystemExit("Usage: python scripts/configure_native.py [android|ios|all]")
    results = []
    if target in {"android", "all"}:
        results.append(configure_android())
    if target in {"ios", "all"}:
        results.append(configure_ios())
    if target != "all" and not all(results):
        raise SystemExit(1)
