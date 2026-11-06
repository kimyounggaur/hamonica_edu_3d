import ctypes as C
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 render.py <output-directory>')
root = Path(sys.argv[1]).resolve()
manifest = json.loads((root/'manifest.json').read_text())
egl = C.CDLL('libEGL.so.1')
U, I, V, F, B, S, P = C.c_uint, C.c_int, C.c_void_p, C.c_float, C.c_ubyte, C.c_char_p, C.POINTER
functions = {
    'GetPlatformDisplay': ([U, V, V], V), 'Initialize': ([V, P(I), P(I)], U),
    'BindAPI': ([U], U), 'ChooseConfig': ([V, P(I), P(V), I, P(I)], U),
    'CreatePbufferSurface': ([V,V,P(I)], V), 'CreateContext': ([V,V,V,P(I)], V),
    'MakeCurrent': ([V,V,V,V], U), 'GetProcAddress': ([S], V), 'GetError': ([],U),
}
for name, (args, result) in functions.items():
    fn = getattr(egl, 'egl'+name)
    fn.argtypes = args
    fn.restype = result

def arr(t, values):
    return (t*len(values))(*values)

d = egl.eglGetPlatformDisplay(0x31DD, None, None)
major = I()
minor = I()
assert egl.eglInitialize(d,C.byref(major),C.byref(minor))
assert egl.eglBindAPI(0x30A0)
config, n = V(), I()
attrs = [0x3033, 1, 0x3040, 4, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3025, 24,
         0x3032, 0, 0x3031, 0, 0x3038]
assert egl.eglChooseConfig(d,arr(I,attrs),C.byref(config),1,C.byref(n)) and n.value
surfaces = {}
for size, dim in manifest['sizes'].items():
    surfaces[size] = egl.eglCreatePbufferSurface(d,config,arr(I,[0x3057,dim['w'],0x3056,dim['h'],0x3038]))
context = egl.eglCreateContext(d,config,None,arr(I,[0x3098,2,0x3038]))
assert context and egl.eglMakeCurrent(d,surfaces['desktop'],surfaces['desktop'],context)

api = {
    'GetString': ([U], S), 'GetError': ([], U), 'CreateShader': ([U], U), 'ShaderSource': ([U,I,P(S),V],None),
    'CompileShader': ([U],None), 'GetShaderiv': ([U,U,P(I)],None), 'GetShaderInfoLog': ([U,I,V,V],None),
    'CreateProgram': ([],U), 'AttachShader': ([U,U],None), 'LinkProgram': ([U],None),
    'GetProgramiv': ([U,U,P(I)],None), 'GetProgramInfoLog': ([U,I,V,V],None), 'UseProgram': ([U],None),
    'GetAttribLocation': ([U,S],I), 'GetUniformLocation': ([U,S],I), 'GenBuffers': ([I,P(U)],None),
    'BindBuffer': ([U,U],None), 'BufferData': ([U,C.c_ssize_t,V,U],None), 'Viewport': ([I,I,I,I],None),
    'Enable': ([U],None), 'Disable': ([U],None), 'DepthMask': ([B],None), 'ClearColor': ([F,F,F,F],None),
    'Clear': ([U],None), 'UniformMatrix4fv': ([I,I,B,P(F)],None), 'Uniform3fv': ([I,I,P(F)],None),
    'EnableVertexAttribArray': ([U],None), 'BlendFuncSeparate': ([U,U,U,U],None),
    'VertexAttribPointer': ([U,I,U,B,I,V],None), 'Uniform1f': ([I,F],None), 'DrawArrays': ([U,I,I],None),
    'ReadPixels': ([I,I,I,I,U,U,V],None),
}
gl = type('GL',(),{})()
for name, (args, result) in api.items():
    setattr(gl,name,C.CFUNCTYPE(result,*args)(egl.eglGetProcAddress(('gl'+name).encode())))

print('EGL',major.value,minor.value,'|',gl.GetString(0x1F01).decode(),'|',gl.GetString(0x1F02).decode())
program = gl.CreateProgram()
for shader_type, code in zip((0x8B31,0x8B30),manifest['shader']):
    shader = gl.CreateShader(shader_type)
    source = S(code.encode())
    gl.ShaderSource(shader,1,C.byref(source),None)
    gl.CompileShader(shader)
    success = I()
    gl.GetShaderiv(shader,0x8B81,C.byref(success))
    if not success.value:
        info = C.create_string_buffer(4096)
        gl.GetShaderInfoLog(shader,4096,None,info)
        raise RuntimeError(info.value.decode())
    gl.AttachShader(program,shader)
gl.LinkProgram(program)
success = I()
gl.GetProgramiv(program,0x8B82,C.byref(success))
assert success.value
uniforms = {name:gl.GetUniformLocation(program,('u'+name).encode()) for name in
    ('View','Projection','Eye','Offset','Color','Metal','Opacity')}
position = gl.GetAttribLocation(program,b'aPosition')
normal = gl.GetAttribLocation(program,b'aNormal')
for mesh in manifest['meshes']:
    buffer = U()
    gl.GenBuffers(1,C.byref(buffer))
    mesh['buffer'] = buffer.value
    gl.BindBuffer(0x8892,buffer)
    data = (root/mesh['filename']).read_bytes()
    gl.BufferData(0x8892,len(data),C.cast(C.c_char_p(data),V),0x88E4)

def paint(group, offset, opacity):
    gl.Uniform3fv(uniforms['Offset'],1,arr(F,offset))
    for i in group:
        mesh = manifest['meshes'][i]
        (gl.Enable if mesh['cull'] else gl.Disable)(0x0B44)
        gl.BindBuffer(0x8892,mesh['buffer'])
        gl.VertexAttribPointer(position,3,0x1406,0,24,None)
        gl.VertexAttribPointer(normal,3,0x1406,0,24,V(12))
        gl.Uniform3fv(uniforms['Color'],1,arr(F,mesh['style']['color']))
        gl.Uniform1f(uniforms['Metal'],mesh['style']['metal'])
        gl.Uniform1f(uniforms['Opacity'],opacity*mesh['alpha'])
        gl.DrawArrays(4,0,mesh['count'])

def render(model, size, view, transparency, alternative=False):
    dim = manifest['sizes'][size]
    w,h = dim['w'],dim['h']
    camera = model[size][view]
    offset = model['alternate' if alternative else 'offset']
    gl.Viewport(0,0,w,h)
    gl.Enable(0x0B71)
    gl.DepthMask(1)
    gl.Disable(0x0BE2)
    gl.ClearColor(16/255,27/255,46/255,1)
    gl.Clear(0x4000|0x100)
    gl.UseProgram(program)
    gl.UniformMatrix4fv(uniforms['View'],1,0,arr(F,camera['view']))
    gl.UniformMatrix4fv(uniforms['Projection'],1,0,arr(F,camera['projection']))
    gl.Uniform3fv(uniforms['Eye'],1,arr(F,camera['eye']))
    gl.EnableVertexAttribArray(position)
    gl.EnableVertexAttribArray(normal)
    gl.BlendFuncSeparate(0x0302,0x0303,1,0x0303)
    paint(model['instrument'],[0,0,0],1)
    paint(model['lips'],offset,1)
    opacity = 1-transparency/100
    if opacity > 0:
        gl.Enable(0x0BE2)
        gl.DepthMask(opacity == 1)
        paint(manifest['face'],offset,opacity)
    gl.DepthMask(1)
    pixels = (B*(w*h*4))()
    gl.ReadPixels(0,0,w,h,0x1908,0x1401,pixels)
    assert not (err := gl.GetError()), hex(err)
    return Image.frombytes('RGBA',(w,h),bytes(pixels)).transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert('RGB')

out = root/'frames'
out.mkdir(exist_ok=True)
for size in manifest['sizes']:
    assert egl.eglMakeCurrent(d,surfaces[size],surfaces[size],context)
    for name, model in manifest['models'].items():
        for view in ('front','back','left','right','free','free-left'):
            for transparency in (0,50,100):
                render(model,size,view,transparency).save(out/f'{size}-{name}-{view}-{transparency:03}.png')
        render(model,size,'free',60).save(out/f'{size}-{name}-initial-060.png')
        render(model,size,'free',50,True).save(out/f'{size}-{name}-free-alternate-050.png')

for size in manifest['sizes']:
    for name in manifest['models']:
        w,h = 320,190
        views = ('front','back','left','right','free','free-left')
        sheet = Image.new('RGB',(w*3,(h+18)*len(views)),(5,10,17))
        draw = ImageDraw.Draw(sheet)
        for row, view in enumerate(views):
            for col, opacity in enumerate((0,50,100)):
                with Image.open(out/f'{size}-{name}-{view}-{opacity:03}.png') as frame:
                    frame.thumbnail((w,h))
                    sheet.paste(frame,(col*w+(w-frame.width)//2,row*(h+18)))
                draw.text((col*w+8,row*(h+18)+h),f'{view} / {opacity}%',fill=(225,230,240))
        sheet.save(root/f'{size}-{name}-sheet.jpg', quality=90)
print(len(list(out.glob('*.png'))), 'frames rendered')
