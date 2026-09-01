import React from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import {App} from './App';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean;message:string}>{state={failed:false,message:''};static getDerivedStateFromError(error:Error){return{failed:true,message:error.message}}componentDidCatch(error:unknown){console.error('Chat UI error',error)}render(){return this.state.failed?<main className="error-screen"><h1>Something went wrong</h1><p>{this.state.message||'The chat UI could not render.'}</p><button onClick={()=>this.setState({failed:false,message:''})}>Try again</button></main>:this.props.children}}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
