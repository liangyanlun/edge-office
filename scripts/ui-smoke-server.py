"""Isolated local UI validation; never read or write the user's workspace DB."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from backend.app import create_app
root=Path(__file__).resolve().parent.parent
data=root/'build/ui-smoke-20261013'
app=create_app({'DATA_DIR':data/'data','INDEX_DIR':data/'indexes','DATABASE_PATH':data/'data/test.db',
                'MODELS_DIR':data/'models','EMBEDDING_MODEL_PATH':'','LLAMA_CPP_ENABLED':False,'TESTING':True})
@app.get('/__test/mobile')
def mobile_test():
    # Test-only fake planner identity: never compiled into production app assets.
    source=(root/'public/index.html').read_text(encoding='utf-8')
    script="""<script>
    globalThis.Capacitor={isNativePlatform:()=>true,Plugins:{OfflineRuntime:{
      status:async()=>({installed:true,name:'4B-test-only',chatModelName:'4B-test-only',nativeInference:true}),
      models:async()=>({items:[]}),
      infer:async()=>({model:'4B-test-only',finishReason:'stop',answer:"replace_paragraph(2,0,'手机中文更新')"})
    }}};
    </script>"""
    return source.replace('<head>','<head><base href="/">'+script)
app.run(host='127.0.0.1',port=5193,debug=False,use_reloader=False)
