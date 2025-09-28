{
  "variables": {
    "use_unimrcp_sdk%": "0",
    "UNIMRCP_SDK_DIR%": "",
    "APR_DIR%": "",
    "SOFIA_DIR%": ""
  },
  "targets": [
    {
      "target_name": "unimrcp",
      "sources": [
        "unimrcp_addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags_cc": [ "-std=c++17" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17", "/utf-8"],
          "ExceptionHandling": 1,
          "DebugInformationFormat": 0
        },
        "VCLinkerTool": {
          "GenerateDebugInformation": "false",
          "LinkIncremental": 1,
          "AdditionalOptions": ["/INCREMENTAL:NO"]
        }
      },
      "conditions": [
        [ "use_unimrcp_sdk==\"1\"", {
          "defines": [ "USE_UNIMRCP_SDK=1" ],
          "include_dirs": [
            "<(UNIMRCP_SDK_DIR)/include",
            "<(APR_DIR)/include",
            "<(SOFIA_DIR)/include"
          ],
          "conditions": [
            [ "OS==\"win\"", {
              "msvs_settings": {
                "VCCLCompilerTool": {
                  "AdditionalIncludeDirectories": "<(UNIMRCP_SDK_DIR)\\include;<(APR_DIR)\\include;<(SOFIA_DIR)\\include;C:\\Program Files\\UniMRCP\\include;C:\\Program Files\\UniMRCP\\include\\apr-1;C:\\Program Files\\UniMRCP\\include\\sofia-sip-ua",
                  "AdditionalOptions": ["/std:c++17", "/utf-8"],
                  "DebugInformationFormat": 0
                },
                "VCLinkerTool": {
                  "AdditionalDependencies": [
                    "unimrcpclient.lib",
                    "apr-1.lib",
                    "aprutil-1.lib",
                    "sofia-sip-ua.lib"
                  ],
                  "AdditionalLibraryDirectories": [
                    "<(UNIMRCP_SDK_DIR)\\lib",
                    "<(APR_DIR)\\lib",
                    "<(SOFIA_DIR)\\lib",
                    "C:\\Program Files\\UniMRCP\\lib"
                  ],
                  "GenerateDebugInformation": "false",
                  "LinkIncremental": 1,
                  "AdditionalOptions": ["/INCREMENTAL:NO"]
                }
              }
            }, {
              "link_settings": {
                "libraries": [
                  "-lunimrcpclient",
                  "-lapr-1",
                  "-laprutil-1",
                  "-lsofia-sip-ua"
                ],
                "library_dirs": [
                  "<(UNIMRCP_SDK_DIR)/lib",
                  "<(APR_DIR)/lib",
                  "<(SOFIA_DIR)/lib"
                ]
              }
            } ]
          ]
        } ]
      ]
    }
  ]
}
