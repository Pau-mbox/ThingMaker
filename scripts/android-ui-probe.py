"""Inspect/test the debug APK through its Android WebView debugging endpoint."""
import json, sys, urllib.request, websocket
pages=json.load(urllib.request.urlopen('http://127.0.0.1:9223/json'))
page=next(p for p in pages if p['url']=='https://appassets.androidplatform.net/index.html')
connection=websocket.create_connection(page['webSocketDebuggerUrl'], suppress_origin=True, timeout=10)
expression=sys.argv[1] if len(sys.argv)>1 else "JSON.stringify(['.app','.shell','.main','.main-pane','.panel','.session-panel','.transcript','.composer'].map(s=>{let e=document.querySelector(s);return e?{s,rect:e.getBoundingClientRect().toJSON(),height:getComputedStyle(e).height,display:getComputedStyle(e).display,flex:getComputedStyle(e).flex,visibility:getComputedStyle(e).visibility,overflow:getComputedStyle(e).overflow}:null}))"
connection.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True}}))
while True:
    frame=json.loads(connection.recv())
    if frame.get('id')==1: print(json.dumps(frame.get('result'),ensure_ascii=False)); break
connection.close()
